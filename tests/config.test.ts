import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config/index.js';

describe('Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Required environment variables', () => {
    it('should use empty string default if PROVER_URL is missing', () => {
      delete process.env.PROVER_URL;
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';

      const config = loadConfig();
      expect(config.proverUrl).toBe('');
    });

    it('should throw if REDIS_URL is missing', () => {
      process.env.PAYMENT_MODE = 'disabled';
      delete process.env.REDIS_URL;

      expect(() => loadConfig()).toThrow(/REDIS_URL/);
    });

    it('should throw if BASE_RPC_URL is missing', () => {
      process.env.PAYMENT_MODE = 'disabled';
      process.env.REDIS_URL = 'redis://redis:6379';
      delete process.env.BASE_RPC_URL;

      expect(() => loadConfig()).toThrow(/BASE_RPC_URL/);
    });

    it('should throw if EAS_GRAPHQL_ENDPOINT is missing', () => {
      process.env.PAYMENT_MODE = 'disabled';
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      delete process.env.EAS_GRAPHQL_ENDPOINT;

      expect(() => loadConfig()).toThrow(/EAS_GRAPHQL_ENDPOINT/);
    });

    it('should throw if A2A_BASE_URL is missing', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      delete process.env.A2A_BASE_URL;

      expect(() => loadConfig()).toThrow(/A2A_BASE_URL/);
    });

    it('should throw if PAYMENT_MODE is invalid', () => {
      process.env.PAYMENT_MODE = 'bogus';

      expect(() => loadConfig()).toThrow(/PAYMENT_MODE must be one of/);
    });

    it('should throw if TEE_MODE is invalid', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      process.env.TEE_MODE = 'invalid';

      expect(() => loadConfig()).toThrow(/TEE_MODE must be one of/);
    });

    it('should accept all valid required env vars', () => {
      process.env.PROVER_URL = 'http://prover:4003';  // optional, but test with value
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';

      const config = loadConfig();
      expect(config.proverUrl).toBe('http://prover:4003');
      expect(config.redisUrl).toBe('redis://redis:6379');
      expect(config.paymentMode).toBe('disabled');
      expect(config.a2aBaseUrl).toBe('http://localhost:4002');
      expect(config.paymentPayTo).toBe('');
      expect(config.paymentFacilitatorUrl).toBe('https://www.x402.org/facilitator');
      expect(config.paymentProofPrice).toBe('$0.10');
    });
  });

  describe('Optional environment variables', () => {
    it('should use default port 4002 if PORT not set', () => {
      delete process.env.PORT;
      const port = parseInt(process.env.PORT || '4002', 10);
      expect(port).toBe(4002);
    });

    it('should use default NODE_ENV development if not set', () => {
      delete process.env.NODE_ENV;
      const nodeEnv = process.env.NODE_ENV || 'development';
      expect(nodeEnv).toBe('development');
    });

    it('should accept custom PORT', () => {
      process.env.PORT = '5000';
      const port = parseInt(process.env.PORT || '4002', 10);
      expect(port).toBe(5000);
    });

    it('should default agentVersion to 1.0.0 if not set', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      delete process.env.AGENT_VERSION;

      const config = loadConfig();
      expect(config.agentVersion).toBe('1.0.0');
    });

    it('should read agentVersion from env when set', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      process.env.AGENT_VERSION = '2.5.3';

      const config = loadConfig();
      expect(config.agentVersion).toBe('2.5.3');
    });
  });

  describe('TEE configuration', () => {
    it('should default TEE_MODE to disabled if not set', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      delete process.env.TEE_MODE;

      const config = loadConfig();
      expect(config.teeMode).toBe('disabled');
    });

    it('should accept valid TEE_MODE values', () => {
      const validModes = ['disabled', 'local', 'nitro'];

      for (const mode of validModes) {
        process.env.REDIS_URL = 'redis://redis:6379';
        process.env.BASE_RPC_URL = 'https://mainnet.base.org';
        process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
        process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
        process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
        process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
        process.env.PAYMENT_MODE = 'disabled';
        process.env.A2A_BASE_URL = 'http://localhost:4002';
        process.env.TEE_MODE = mode;

        const config = loadConfig();
        expect(config.teeMode).toBe(mode);
      }
    });

    it('should parse ENCLAVE_CID as number', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      process.env.TEE_MODE = 'nitro';
      process.env.ENCLAVE_CID = '16';

      const config = loadConfig();
      expect(config.enclaveCid).toBe(16);
    });

    it('should default ENCLAVE_PORT to 5000', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      process.env.TEE_MODE = 'disabled';
      delete process.env.ENCLAVE_PORT;

      const config = loadConfig();
      expect(config.enclavePort).toBe(5000);
    });

    it('should parse custom ENCLAVE_PORT', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      process.env.TEE_MODE = 'disabled';
      process.env.ENCLAVE_PORT = '6000';

      const config = loadConfig();
      expect(config.enclavePort).toBe(6000);
    });

    it('should parse TEE_ATTESTATION as boolean', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      process.env.TEE_MODE = 'disabled';
      process.env.TEE_ATTESTATION = 'true';

      const config = loadConfig();
      expect(config.teeAttestationEnabled).toBe(true);
    });

    it('should default teeAttestationEnabled to false', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      process.env.TEE_MODE = 'disabled';
      delete process.env.TEE_ATTESTATION;

      const config = loadConfig();
      expect(config.teeAttestationEnabled).toBe(false);
    });
  });

  describe('ERC-8004 Identity configuration', () => {
    it('should default ERC8004_IDENTITY_ADDRESS to empty string', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      delete process.env.ERC8004_IDENTITY_ADDRESS;

      const config = loadConfig();
      expect(config.erc8004IdentityAddress).toBe('');
    });

    it('should default ERC8004_REPUTATION_ADDRESS to empty string', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      delete process.env.ERC8004_REPUTATION_ADDRESS;

      const config = loadConfig();
      expect(config.erc8004ReputationAddress).toBe('');
    });

    it('should read ERC8004_IDENTITY_ADDRESS from env', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      process.env.ERC8004_IDENTITY_ADDRESS = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

      const config = loadConfig();
      expect(config.erc8004IdentityAddress).toBe('0x8004A818BFB912233c491871b3d84c89A494BD9e');
    });

    it('should read ERC8004_REPUTATION_ADDRESS from env', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
      process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
      process.env.NULLIFIER_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
      process.env.PROVER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      process.env.PAYMENT_MODE = 'disabled';
      process.env.A2A_BASE_URL = 'http://localhost:4002';
      process.env.ERC8004_REPUTATION_ADDRESS = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

      const config = loadConfig();
      expect(config.erc8004ReputationAddress).toBe('0x8004B663056A597Dffe9eCcC1965A193B7388713');
    });
  });
});
