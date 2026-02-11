/**
 * Identity Integration Tests - HTTP Endpoints
 * Tests the Express app /identity/status endpoint
 */

import { describe, it, expect, beforeAll } from 'vitest';
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

describe('Identity HTTP Integration', () => {
  let app: Express;

  beforeAll(() => {
    const { app: testApp } = createApp(makeTestConfig({
      erc8004IdentityAddress: '',
      erc8004ReputationAddress: '',
    }));
    app = testApp;
  });

  describe('GET /identity/status', () => {
    it('should return identity status when not configured', async () => {
      const response = await request(app).get('/identity/status');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        erc8004: {
          identityContract: null,
          reputationContract: null,
          configured: false,
        },
      });
    });

    it('should return configured: false when contracts not set', async () => {
      const response = await request(app).get('/identity/status');

      expect(response.status).toBe(200);
      expect(response.body.erc8004.configured).toBe(false);
    });

    it('should return null for contract addresses when not configured', async () => {
      const response = await request(app).get('/identity/status');

      expect(response.status).toBe(200);
      expect(response.body.erc8004.identityContract).toBeNull();
      expect(response.body.erc8004.reputationContract).toBeNull();
    });
  });

  describe('ERC-8004 configured', () => {
    it('should show addresses when both contracts are configured', async () => {
      const { app: testApp } = createApp(makeTestConfig({
        erc8004IdentityAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        erc8004ReputationAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      }));

      const response = await request(testApp).get('/identity/status');

      expect(response.status).toBe(200);
      expect(response.body.erc8004.identityContract).toBe('0x8004A818BFB912233c491871b3d84c89A494BD9e');
      expect(response.body.erc8004.reputationContract).toBe('0x8004B663056A597Dffe9eCcC1965A193B7388713');
      expect(response.body.erc8004.configured).toBe(true);
    });

    it('should show configured: false when only identity contract is set', async () => {
      const { app: testApp } = createApp(makeTestConfig({
        erc8004IdentityAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        erc8004ReputationAddress: '',
      }));

      const response = await request(testApp).get('/identity/status');

      expect(response.status).toBe(200);
      expect(response.body.erc8004.configured).toBe(false);
    });

    it('should show configured: false when only reputation contract is set', async () => {
      const { app: testApp } = createApp(makeTestConfig({
        erc8004IdentityAddress: '',
        erc8004ReputationAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      }));

      const response = await request(testApp).get('/identity/status');

      expect(response.status).toBe(200);
      expect(response.body.erc8004.configured).toBe(false);
    });
  });

  describe('Response format validation', () => {
    it('should return JSON response', async () => {
      const response = await request(app).get('/identity/status');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/json/);
    });

    it('should have correct structure', async () => {
      const response = await request(app).get('/identity/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('erc8004');
      expect(response.body.erc8004).toHaveProperty('identityContract');
      expect(response.body.erc8004).toHaveProperty('reputationContract');
      expect(response.body.erc8004).toHaveProperty('configured');
    });

    it('should have boolean configured field', async () => {
      const response = await request(app).get('/identity/status');

      expect(response.status).toBe(200);
      expect(typeof response.body.erc8004.configured).toBe('boolean');
    });

    it('should return string or null for contract addresses', async () => {
      const response = await request(app).get('/identity/status');

      expect(response.status).toBe(200);
      const identityType = typeof response.body.erc8004.identityContract;
      const reputationType = typeof response.body.erc8004.reputationContract;

      expect(['string', 'object']).toContain(identityType); // object for null
      expect(['string', 'object']).toContain(reputationType); // object for null

      if (identityType === 'object') {
        expect(response.body.erc8004.identityContract).toBeNull();
      }
      if (reputationType === 'object') {
        expect(response.body.erc8004.reputationContract).toBeNull();
      }
    });
  });
});
