/**
 * TEE Integration Tests - HTTP Endpoints
 * Tests the Express app /tee/status endpoint
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/index.js';
import type { Config } from '../../src/config/index.js';

function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 4002,
    nodeEnv: 'test',
    proverUrl: '',
    bbPath: 'bb',
    nargoPath: 'nargo',
    circuitsDir: './circuits',
    circuitsRepoUrl: '',
    redisUrl: 'redis://localhost:6379',
    baseRpcUrl: 'https://mainnet.base.org',
    easGraphqlEndpoint: 'https://base.easscan.org/graphql',
    chainRpcUrl: 'https://sepolia.base.org',
    nullifierRegistryAddress: '0xC6a8dC34B1872a883aFCc808C90c31c038764d9a',
    proverPrivateKey: '0x5c8eb0e0dcdcdabdc87f1fae3e992132e8a06b83188dfba625ca95036876bb0a',
    paymentMode: 'disabled' as const,
    a2aBaseUrl: 'http://localhost:4002',
    agentVersion: '1.0.0',
    paymentPayTo: '',
    paymentFacilitatorUrl: 'https://www.x402.org/facilitator',
    paymentProofPrice: '$0.10',
    privyAppId: '',
    privyApiSecret: '',
    privyApiUrl: 'https://auth.privy.io',
    signPageUrl: '',
    signingTtlSeconds: 300,
    teeMode: 'disabled' as const,
    enclaveCid: undefined,
    enclavePort: 5000,
    teeAttestationEnabled: false,
    erc8004IdentityAddress: '',
    erc8004ReputationAddress: '',
    ...overrides,
  };
}

describe('TEE HTTP Integration', () => {
  let app: Express;
  let originalTeeMode: string | undefined;

  beforeAll(() => {
    originalTeeMode = process.env.TEE_MODE;
    process.env.TEE_MODE = 'disabled';
    const { app: testApp } = createApp(makeTestConfig({ teeMode: 'disabled' as const }));
    app = testApp;
  });

  afterAll(() => {
    if (originalTeeMode !== undefined) {
      process.env.TEE_MODE = originalTeeMode;
    } else {
      delete process.env.TEE_MODE;
    }
  });

  describe('GET /tee/status', () => {
    it('should return TEE status with disabled mode', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        mode: 'disabled',
        attestationEnabled: false,
        available: false,
      });
    });

    it('should return available: false when TEE is disabled', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body.available).toBe(false);
    });

    it('should include attestationEnabled field', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('attestationEnabled');
      expect(typeof response.body.attestationEnabled).toBe('boolean');
    });

    it('should include mode field', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('mode');
      expect(['disabled', 'local', 'nitro']).toContain(response.body.mode);
    });
  });

  describe('TEE mode variations', () => {
    it('should handle local mode configuration', async () => {
      const originalMode = process.env.TEE_MODE;
      process.env.TEE_MODE = 'local';

      const { app: testApp } = createApp(makeTestConfig({ teeMode: 'local' as const }));

      const response = await request(testApp).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe('local');
      expect(response.body.available).toBe(true);

      if (originalMode !== undefined) {
        process.env.TEE_MODE = originalMode;
      } else {
        delete process.env.TEE_MODE;
      }
    });

    it('should handle nitro mode configuration', async () => {
      const originalMode = process.env.TEE_MODE;
      const originalCid = process.env.ENCLAVE_CID;
      process.env.TEE_MODE = 'nitro';
      process.env.ENCLAVE_CID = '16';

      const { app: testApp } = createApp(makeTestConfig({
        teeMode: 'nitro' as const,
        enclaveCid: 16,
      }));

      const response = await request(testApp).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe('nitro');
      expect(response.body.available).toBe(true);

      if (originalMode !== undefined) {
        process.env.TEE_MODE = originalMode;
      } else {
        delete process.env.TEE_MODE;
      }
      if (originalCid !== undefined) {
        process.env.ENCLAVE_CID = originalCid;
      } else {
        delete process.env.ENCLAVE_CID;
      }
    });
  });

  describe('Response format validation', () => {
    it('should return JSON response', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/json/);
    });

    it('should have all required fields', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('mode');
      expect(response.body).toHaveProperty('attestationEnabled');
      expect(response.body).toHaveProperty('available');
    });

    it('should not have extra fields', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      const keys = Object.keys(response.body);
      expect(keys).toHaveLength(3);
      expect(keys).toContain('mode');
      expect(keys).toContain('attestationEnabled');
      expect(keys).toContain('available');
    });
  });
});
