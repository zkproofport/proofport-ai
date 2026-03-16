/**
 * Enclave client for communication with AWS Nitro Enclave via vsock
 */

import { createHash } from 'crypto';
import { connect, Socket } from 'net';
import type { TeeConfig, TeeProvider, VsockRequest, VsockResponse, AttestationDocument } from './types.js';
import type { EncryptedEnvelope, TeePublicKeyInfo } from './teeKeyExchange.js';
import { computeKeyId } from './teeKeyExchange.js';
import { parseAttestationDocument } from './attestation.js';
import { createLogger } from '../logger.js';

const log = createLogger('Enclave');

export class EnclaveClient implements TeeProvider {
  readonly mode: TeeConfig['mode'];
  private config: TeeConfig;
  private lastAttestation: AttestationDocument | null = null;
  private teePublicKeyCache: TeePublicKeyInfo | null = null;

  constructor(config: TeeConfig) {
    this.config = config;
    this.mode = config.mode;

    if (config.mode === 'nitro' && !config.enclaveCid) {
      throw new Error('EnclaveClient: enclaveCid is required for nitro mode');
    }
  }

  async prove(circuitId: string, inputs: Record<string, any>, requestId: string): Promise<VsockResponse> {
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
        log.error({ action: 'enclave.attestation.parse_failed', err: error }, 'Failed to parse attestation document');
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
      log.error({ action: 'enclave.health.failed', err: error }, 'Health check failed');
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

      log.error({ action: 'enclave.attestation.no_document', responseType: response.type, error: response.error }, 'Enclave responded without attestationDocument');
      return null;
    } catch (error) {
      log.error({ action: 'enclave.attestation.failed', err: error }, 'Failed to get nitro attestation');
      return null;
    }
  }

  async getTeePublicKey(): Promise<TeePublicKeyInfo | null> {
    if (this.mode === 'local' || this.mode === 'disabled') {
      return null;
    }

    // Return cached key if available
    if (this.teePublicKeyCache) {
      return this.teePublicKeyCache;
    }

    try {
      const request: VsockRequest = {
        type: 'getPublicKey',
        requestId: `pubkey-${Date.now()}`,
      };

      const response = await this.sendVsockRequest(request);

      if (response.type === 'publicKey' && response.publicKey) {
        this.teePublicKeyCache = {
          publicKey: response.publicKey,
          keyId: response.keyId || computeKeyId(response.publicKey),
          attestationDocument: response.attestationDocument,
        };

        log.info({
          action: 'enclave.publicKey.fetched',
          keyId: this.teePublicKeyCache.keyId,
        }, 'TEE public key fetched and cached');

        return this.teePublicKeyCache;
      }

      log.error({ action: 'enclave.publicKey.failed', response }, 'Failed to get TEE public key');
      return null;
    } catch (error) {
      log.error({ action: 'enclave.publicKey.error', err: error }, 'Failed to fetch TEE public key');
      return null;
    }
  }

  async proveEncrypted(encryptedPayload: EncryptedEnvelope, requestId: string): Promise<VsockResponse> {
    if (this.mode === 'local') {
      return { type: 'error', requestId, error: 'E2E encryption not supported in local mode' };
    }

    const request: VsockRequest = {
      type: 'prove',
      encryptedPayload,
      requestId,
    };

    const response = await this.sendVsockRequest(request);

    // Cache attestation document if present
    if (response.attestationDocument && this.config.attestationEnabled) {
      try {
        this.lastAttestation = parseAttestationDocument(response.attestationDocument);
      } catch (error) {
        log.error({ action: 'enclave.attestation.parse_failed', err: error }, 'Failed to parse attestation document');
      }
    }

    return response;
  }

  /** Invalidate cached TEE public key (called on KEY_ROTATED error) */
  invalidatePublicKeyCache(): void {
    this.teePublicKeyCache = null;
    log.info({ action: 'enclave.publicKey.invalidated' }, 'TEE public key cache invalidated');
  }

  private async sendVsockRequest(request: VsockRequest): Promise<VsockResponse> {
    return new Promise((resolve, reject) => {
      // Connect via TCP bridge (vsock-bridge.py on host forwards to enclave)
      // Node.js net module doesn't support AF_VSOCK natively, so we use
      // a TCP-to-vsock proxy running on the host at bridgePort (default 15000).
      const bridgePort = this.config.enclaveBridgePort || 15000;

      log.debug({ action: 'enclave.connecting', bridgePort }, 'Connecting to enclave via TCP bridge');

      const socket: Socket = connect({
        host: '127.0.0.1',
        port: bridgePort,
      });

      let responseData = '';

      socket.on('connect', () => {
        socket.write(JSON.stringify(request));
        socket.end(); // Signal end of request so bridge forwards to enclave
      });

      socket.on('data', (data: Buffer) => {
        responseData += data.toString();
      });

      socket.on('end', () => {
        if (!responseData) {
          reject(new Error('Empty response from enclave'));
          return;
        }
        try {
          const response: VsockResponse = JSON.parse(responseData);
          resolve(response);
        } catch (error) {
          reject(new Error(`Invalid JSON from enclave: ${responseData.substring(0, 200)}`));
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

      // Proof generation can take 30-90 seconds
      socket.setTimeout(120000);
    });
  }

  private async simulateLocalProof(
    circuitId: string,
    inputs: Record<string, any>,
    requestId: string
  ): Promise<VsockResponse> {
    // Simulate proof generation delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Return mock proof for local development
    return {
      type: 'proof',
      requestId,
      proof: `0x${Buffer.from(`mock-proof-${circuitId}-${Date.now()}`).toString('hex')}`,
      publicInputs: Object.values(inputs).slice(0, 3).map((v) => `0x${String(v).slice(0, 8)}`),
    };
  }
}
