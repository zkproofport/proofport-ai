/**
 * Enclave client for communication with AWS Nitro Enclave via vsock
 */

import { createHash } from 'crypto';
import { connect, Socket } from 'net';
import type { TeeConfig, TeeProvider, VsockRequest, VsockResponse, AttestationDocument } from './types.js';
import { parseAttestationDocument } from './attestation.js';

export class EnclaveClient implements TeeProvider {
  readonly mode: TeeConfig['mode'];
  private config: TeeConfig;
  private lastAttestation: AttestationDocument | null = null;

  constructor(config: TeeConfig) {
    this.config = config;
    this.mode = config.mode;

    if (config.mode === 'nitro' && !config.enclaveCid) {
      throw new Error('EnclaveClient: enclaveCid is required for nitro mode');
    }
  }

  async prove(circuitId: string, inputs: string[], requestId: string): Promise<VsockResponse> {
    if (this.mode === 'local') {
      return this.simulateLocalProof(circuitId, inputs, requestId);
    }

    const request: VsockRequest = {
      type: 'prove',
      circuitId,
      inputs,
      requestId,
    };

    const response = await this.sendVsockRequest(request);

    // Cache attestation document if present
    if (response.attestationDocument && this.config.attestationEnabled) {
      try {
        this.lastAttestation = parseAttestationDocument(response.attestationDocument);
      } catch (error) {
        console.error('Failed to parse attestation document:', error);
      }
    }

    return response;
  }

  async healthCheck(): Promise<boolean> {
    if (this.mode === 'local') {
      return true;
    }

    try {
      const requestId = `health-${Date.now()}`;
      const request: VsockRequest = {
        type: 'health',
        requestId,
      };

      const response = await this.sendVsockRequest(request);
      return response.type === 'health';
    } catch (error) {
      console.error('Health check failed:', error);
      return false;
    }
  }

  async getAttestation(): Promise<AttestationDocument | null> {
    if (this.mode === 'local' || !this.config.attestationEnabled) {
      return null;
    }

    return this.lastAttestation;
  }

  async generateAttestation(proofHash: string, metadata?: Record<string, unknown>): Promise<import('./types.js').AttestationResult | null> {
    if (!this.config.attestationEnabled) {
      return null;
    }

    const timestamp = Date.now();

    if (this.mode === 'local') {
      // Simulated attestation for local development
      const simulatedDoc = {
        type: 'simulated',
        mode: 'local' as const,
        proofHash,
        timestamp,
        pcrs: {
          0: 'simulated-pcr0-' + createHash('sha256').update('local-enclave-image').digest('hex').substring(0, 32),
          1: 'simulated-pcr1-' + createHash('sha256').update('local-kernel').digest('hex').substring(0, 32),
          2: 'simulated-pcr2-' + createHash('sha256').update('local-application').digest('hex').substring(0, 32),
        },
        metadata: metadata || {},
      };

      return {
        document: Buffer.from(JSON.stringify(simulatedDoc)).toString('base64'),
        mode: 'local',
        proofHash,
        timestamp,
      };
    }

    // Nitro mode: request attestation from enclave
    try {
      const request = {
        type: 'attestation' as const,
        requestId: `att-${Date.now()}`,
        proofHash,
        metadata,
      };

      const response = await this.sendVsockRequest(request as any);

      if (response.attestationDocument) {
        return {
          document: response.attestationDocument,
          mode: 'nitro',
          proofHash,
          timestamp,
        };
      }

      return null;
    } catch (error) {
      console.error('[TEE] Failed to get nitro attestation:', error);
      return null;
    }
  }

  private async sendVsockRequest(request: VsockRequest): Promise<VsockResponse> {
    return new Promise((resolve, reject) => {
      const port = this.config.enclavePort || 5000;
      const cid = this.config.enclaveCid!;

      // Vsock connection via AF_VSOCK (address family for vsock)
      // Node.js net module supports vsock but types don't reflect it
      const socket: Socket = connect({
        path: `/dev/vsock`,
        vsockCid: cid,
        vsockPort: port,
      } as any);

      let responseData = '';

      socket.on('connect', () => {
        socket.write(JSON.stringify(request));
      });

      socket.on('data', (data: Buffer) => {
        responseData += data.toString();
        try {
          const response: VsockResponse = JSON.parse(responseData);
          socket.end();
          resolve(response);
        } catch (error) {
          // Partial data received, wait for more
        }
      });

      socket.on('error', (error: Error) => {
        socket.destroy();
        reject(error);
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      });

      // Set 30 second timeout
      socket.setTimeout(30000);
    });
  }

  private async simulateLocalProof(
    circuitId: string,
    inputs: string[],
    requestId: string
  ): Promise<VsockResponse> {
    // Simulate proof generation delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Return mock proof for local development
    return {
      type: 'proof',
      requestId,
      proof: `0x${Buffer.from(`mock-proof-${circuitId}-${Date.now()}`).toString('hex')}`,
      publicInputs: inputs.slice(0, 3).map((input) => `0x${parseInt(input, 10).toString(16)}`),
    };
  }
}
