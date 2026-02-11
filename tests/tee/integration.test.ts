import { describe, it, expect, beforeEach } from 'vitest';
import type { TeeConfig } from '../../src/tee/types.js';

describe('TEE Integration', () => {
  let createTeeProvider: any;
  let getTeeConfig: any;

  beforeEach(async () => {
    const module = await import('../../src/tee/index.js');
    createTeeProvider = module.createTeeProvider;
    getTeeConfig = module.getTeeConfig;
  });

  describe('getTeeConfig()', () => {
    it('should return disabled mode by default', () => {
      const config = getTeeConfig();
      expect(config.mode).toBe('disabled');
      expect(config.attestationEnabled).toBe(false);
    });

    it('should read TEE_MODE from environment', () => {
      const originalEnv = process.env.TEE_MODE;
      process.env.TEE_MODE = 'local';

      const config = getTeeConfig();
      expect(config.mode).toBe('local');

      process.env.TEE_MODE = originalEnv;
    });

    it('should read ENCLAVE_CID from environment', () => {
      const originalMode = process.env.TEE_MODE;
      const originalCid = process.env.ENCLAVE_CID;
      process.env.TEE_MODE = 'nitro';
      process.env.ENCLAVE_CID = '16';

      const config = getTeeConfig();
      expect(config.enclaveCid).toBe(16);

      process.env.TEE_MODE = originalMode;
      process.env.ENCLAVE_CID = originalCid;
    });

    it('should read ENCLAVE_PORT from environment', () => {
      const originalMode = process.env.TEE_MODE;
      const originalCid = process.env.ENCLAVE_CID;
      const originalPort = process.env.ENCLAVE_PORT;
      process.env.TEE_MODE = 'nitro';
      process.env.ENCLAVE_CID = '16';
      process.env.ENCLAVE_PORT = '6000';

      const config = getTeeConfig();
      expect(config.enclavePort).toBe(6000);

      process.env.TEE_MODE = originalMode;
      process.env.ENCLAVE_CID = originalCid;
      process.env.ENCLAVE_PORT = originalPort;
    });

    it('should default enclavePort to 5000 if not specified', () => {
      const originalMode = process.env.TEE_MODE;
      const originalCid = process.env.ENCLAVE_CID;
      const originalPort = process.env.ENCLAVE_PORT;
      process.env.TEE_MODE = 'nitro';
      process.env.ENCLAVE_CID = '16';
      delete process.env.ENCLAVE_PORT;

      const config = getTeeConfig();
      expect(config.enclavePort).toBe(5000);

      process.env.TEE_MODE = originalMode;
      process.env.ENCLAVE_CID = originalCid;
      process.env.ENCLAVE_PORT = originalPort;
    });

    it('should enable attestation when TEE_ATTESTATION=true', () => {
      const originalAttestation = process.env.TEE_ATTESTATION;
      process.env.TEE_ATTESTATION = 'true';

      const config = getTeeConfig();
      expect(config.attestationEnabled).toBe(true);

      process.env.TEE_ATTESTATION = originalAttestation;
    });

    it('should disable attestation by default', () => {
      const originalAttestation = process.env.TEE_ATTESTATION;
      delete process.env.TEE_ATTESTATION;

      const config = getTeeConfig();
      expect(config.attestationEnabled).toBe(false);

      process.env.TEE_ATTESTATION = originalAttestation;
    });
  });

  describe('createTeeProvider()', () => {
    it('should create EnclaveClient for nitro mode', () => {
      const config: TeeConfig = {
        mode: 'nitro',
        enclaveCid: 16,
        enclavePort: 5000,
        attestationEnabled: false,
      };

      const provider = createTeeProvider(config);
      expect(provider).toBeDefined();
      expect(provider.mode).toBe('nitro');
    });

    it('should create EnclaveClient for local mode', () => {
      const config: TeeConfig = {
        mode: 'local',
        attestationEnabled: false,
      };

      const provider = createTeeProvider(config);
      expect(provider).toBeDefined();
      expect(provider.mode).toBe('local');
    });

    it('should create DisabledProvider for disabled mode', () => {
      const config: TeeConfig = {
        mode: 'disabled',
        attestationEnabled: false,
      };

      const provider = createTeeProvider(config);
      expect(provider).toBeDefined();
      expect(provider.mode).toBe('disabled');
    });

    it('should throw if nitro mode without enclaveCid', () => {
      const config: TeeConfig = {
        mode: 'nitro',
        attestationEnabled: false,
      };

      expect(() => createTeeProvider(config)).toThrow(/enclaveCid/i);
    });
  });

  describe('DisabledProvider', () => {
    it('should return error on prove()', async () => {
      const config: TeeConfig = {
        mode: 'disabled',
        attestationEnabled: false,
      };

      const provider = createTeeProvider(config);
      const result = await provider.prove('coinbase_attestation', ['100'], 'req-123');

      expect(result.type).toBe('error');
      expect(result.error).toContain('TEE is disabled');
    });

    it('should return false on healthCheck()', async () => {
      const config: TeeConfig = {
        mode: 'disabled',
        attestationEnabled: false,
      };

      const provider = createTeeProvider(config);
      const isHealthy = await provider.healthCheck();

      expect(isHealthy).toBe(false);
    });

    it('should return null on getAttestation()', async () => {
      const config: TeeConfig = {
        mode: 'disabled',
        attestationEnabled: false,
      };

      const provider = createTeeProvider(config);
      const attestation = await provider.getAttestation();

      expect(attestation).toBeNull();
    });
  });

  describe('Environment variable validation', () => {
    it('should handle invalid TEE_MODE gracefully', () => {
      const originalMode = process.env.TEE_MODE;
      process.env.TEE_MODE = 'invalid-mode';

      const config = getTeeConfig();
      // Should default to disabled for invalid mode
      expect(config.mode).toBe('disabled');

      process.env.TEE_MODE = originalMode;
    });

    it('should handle non-numeric ENCLAVE_CID', () => {
      const originalMode = process.env.TEE_MODE;
      const originalCid = process.env.ENCLAVE_CID;
      process.env.TEE_MODE = 'nitro';
      process.env.ENCLAVE_CID = 'not-a-number';

      const config = getTeeConfig();
      expect(config.enclaveCid).toBeUndefined();

      process.env.TEE_MODE = originalMode;
      process.env.ENCLAVE_CID = originalCid;
    });

    it('should handle non-numeric ENCLAVE_PORT', () => {
      const originalMode = process.env.TEE_MODE;
      const originalCid = process.env.ENCLAVE_CID;
      const originalPort = process.env.ENCLAVE_PORT;
      process.env.TEE_MODE = 'nitro';
      process.env.ENCLAVE_CID = '16';
      process.env.ENCLAVE_PORT = 'not-a-number';

      const config = getTeeConfig();
      expect(config.enclavePort).toBe(5000); // Should default to 5000

      process.env.TEE_MODE = originalMode;
      process.env.ENCLAVE_CID = originalCid;
      process.env.ENCLAVE_PORT = originalPort;
    });
  });

  describe('Full TEE workflow', () => {
    it('should support local mode workflow', async () => {
      const config: TeeConfig = {
        mode: 'local',
        attestationEnabled: false,
      };

      const provider = createTeeProvider(config);

      // Health check
      const isHealthy = await provider.healthCheck();
      expect(isHealthy).toBe(true);

      // Prove
      const result = await provider.prove('coinbase_attestation', ['100'], 'req-local');
      expect(result.type).toBe('proof');
      expect(result.proof).toBeDefined();

      // Attestation
      const attestation = await provider.getAttestation();
      expect(attestation).toBeNull(); // Local mode doesn't provide attestation
    });
  });
});
