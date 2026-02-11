import { describe, it, expect } from 'vitest';
import type {
  TeeMode,
  TeeConfig,
  EnclaveImageConfig,
  VsockRequest,
  VsockResponse,
  AttestationDocument,
  TeeProvider,
} from '../../src/tee/types.js';

describe('TEE Types', () => {
  describe('TeeMode', () => {
    it('should accept valid TeeMode values', () => {
      const validModes: TeeMode[] = ['disabled', 'local', 'nitro'];
      expect(validModes).toHaveLength(3);
      expect(validModes).toContain('disabled');
      expect(validModes).toContain('local');
      expect(validModes).toContain('nitro');
    });
  });

  describe('TeeConfig', () => {
    it('should allow disabled mode without enclave config', () => {
      const config: TeeConfig = {
        mode: 'disabled',
        attestationEnabled: false,
      };
      expect(config.mode).toBe('disabled');
      expect(config.enclaveCid).toBeUndefined();
      expect(config.enclavePort).toBeUndefined();
    });

    it('should allow local mode with optional enclave config', () => {
      const config: TeeConfig = {
        mode: 'local',
        attestationEnabled: false,
      };
      expect(config.mode).toBe('local');
    });

    it('should allow nitro mode with full enclave config', () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        enclavePort: 5000,
        attestationEnabled: true,
      };
      expect(config.mode).toBe('nitro');
      expect(config.enclaveCid).toBe(16);
      expect(config.enclavePort).toBe(5000);
      expect(config.attestationEnabled).toBe(true);
    });
  });

  describe('EnclaveImageConfig', () => {
    it('should validate structure', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      expect(config.circuits).toHaveLength(1);
      expect(config.circuits[0]).toBe('coinbase_attestation');
      expect(config.outputPath).toMatch(/\.eif$/);
    });

    it('should allow multiple circuits', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation', 'coinbase_country_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      expect(config.circuits).toHaveLength(2);
    });
  });

  describe('VsockRequest', () => {
    it('should support prove request type', () => {
      const request: VsockRequest = {
        type: 'prove',
        circuitId: 'coinbase_attestation',
        inputs: ['149', '2', '100'],
        requestId: 'req-123',
      };
      expect(request.type).toBe('prove');
      expect(request.circuitId).toBe('coinbase_attestation');
      expect(request.inputs).toHaveLength(3);
    });

    it('should support health check request type', () => {
      const request: VsockRequest = {
        type: 'health',
        requestId: 'req-health-123',
      };
      expect(request.type).toBe('health');
      expect(request.circuitId).toBeUndefined();
      expect(request.inputs).toBeUndefined();
    });
  });

  describe('VsockResponse', () => {
    it('should support proof response type', () => {
      const response: VsockResponse = {
        type: 'proof',
        requestId: 'req-123',
        proof: '0xabcd',
        publicInputs: ['0x01', '0x02'],
        attestationDocument: 'base64encodeddata',
      };
      expect(response.type).toBe('proof');
      expect(response.proof).toBe('0xabcd');
      expect(response.publicInputs).toHaveLength(2);
      expect(response.attestationDocument).toBeTruthy();
    });

    it('should support health response type', () => {
      const response: VsockResponse = {
        type: 'health',
        requestId: 'req-health-123',
      };
      expect(response.type).toBe('health');
      expect(response.proof).toBeUndefined();
    });

    it('should support error response type', () => {
      const response: VsockResponse = {
        type: 'error',
        requestId: 'req-123',
        error: 'Proof generation failed',
      };
      expect(response.type).toBe('error');
      expect(response.error).toBe('Proof generation failed');
    });
  });

  describe('AttestationDocument', () => {
    it('should validate structure', () => {
      const doc: AttestationDocument = {
        moduleId: 'i-1234567890abcdef0-enc1234567890abcd',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: new Map([
          [0, Buffer.from('pcr0hash')],
          [1, Buffer.from('pcr1hash')],
          [2, Buffer.from('pcr2hash')],
        ]),
        certificate: Buffer.from('cert'),
        cabundle: [Buffer.from('ca1'), Buffer.from('ca2')],
        publicKey: Buffer.from('pubkey'),
        userData: Buffer.from('userdata'),
        nonce: Buffer.from('nonce'),
      };
      expect(doc.digest).toBe('SHA384');
      expect(doc.pcrs.size).toBe(3);
      expect(doc.cabundle).toHaveLength(2);
    });

    it('should allow optional fields', () => {
      const doc: AttestationDocument = {
        moduleId: 'i-1234567890abcdef0-enc1234567890abcd',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: new Map(),
        certificate: Buffer.from('cert'),
        cabundle: [],
      };
      expect(doc.publicKey).toBeUndefined();
      expect(doc.userData).toBeUndefined();
      expect(doc.nonce).toBeUndefined();
    });
  });

  describe('TeeProvider interface', () => {
    it('should define contract for TeeProvider', () => {
      const mockProvider: TeeProvider = {
        mode: 'local',
        prove: async (circuitId, inputs, requestId) => ({
          type: 'proof',
          requestId,
          proof: '0xmockproof',
          publicInputs: ['0x01'],
        }),
        healthCheck: async () => true,
        getAttestation: async () => null,
      };

      expect(mockProvider.mode).toBe('local');
      expect(typeof mockProvider.prove).toBe('function');
      expect(typeof mockProvider.healthCheck).toBe('function');
      expect(typeof mockProvider.getAttestation).toBe('function');
    });

    it('should support all TeeMode values', () => {
      const disabledProvider: TeeProvider = {
        mode: 'disabled',
        prove: async () => ({ type: 'error', requestId: '', error: 'disabled' }),
        healthCheck: async () => true,
        getAttestation: async () => null,
      };
      expect(disabledProvider.mode).toBe('disabled');

      const localProvider: TeeProvider = {
        mode: 'local',
        prove: async () => ({ type: 'proof', requestId: '', proof: '', publicInputs: [] }),
        healthCheck: async () => true,
        getAttestation: async () => null,
      };
      expect(localProvider.mode).toBe('local');

      const nitroProvider: TeeProvider = {
        mode: 'nitro',
        prove: async () => ({ type: 'proof', requestId: '', proof: '', publicInputs: [] }),
        healthCheck: async () => true,
        getAttestation: async () => ({
          moduleId: 'test',
          digest: 'SHA384',
          timestamp: 0,
          pcrs: new Map(),
          certificate: Buffer.from(''),
          cabundle: [],
        }),
      };
      expect(nitroProvider.mode).toBe('nitro');
    });
  });
});
