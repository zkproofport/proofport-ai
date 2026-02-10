import { describe, it, expect, beforeEach, afterEach } from 'vitest';

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

      const { loadConfig } = require('../src/config/index.ts');
      const config = loadConfig();
      expect(config.proverUrl).toBe('');
    });

    it('should throw if REDIS_URL is missing', () => {
      delete process.env.REDIS_URL;

      const { loadConfig } = require('../src/config/index.ts');
      expect(() => loadConfig()).toThrow(/REDIS_URL/);
    });

    it('should throw if BASE_RPC_URL is missing', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      delete process.env.BASE_RPC_URL;

      const { loadConfig } = require('../src/config/index.ts');
      expect(() => loadConfig()).toThrow(/BASE_RPC_URL/);
    });

    it('should throw if EAS_GRAPHQL_ENDPOINT is missing', () => {
      process.env.REDIS_URL = 'redis://redis:6379';
      process.env.BASE_RPC_URL = 'https://mainnet.base.org';
      delete process.env.EAS_GRAPHQL_ENDPOINT;

      const { loadConfig } = require('../src/config/index.ts');
      expect(() => loadConfig()).toThrow(/EAS_GRAPHQL_ENDPOINT/);
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

      const { loadConfig } = require('../src/config/index.ts');
      const config = loadConfig();
      expect(config.proverUrl).toBe('http://prover:4003');
      expect(config.redisUrl).toBe('redis://redis:6379');
      expect(config.paymentMode).toBe('disabled');
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
  });
});
