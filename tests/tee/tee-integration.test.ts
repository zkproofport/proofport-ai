/**
 * TEE Integration Tests - HTTP Endpoints
 * Tests the Express app /health endpoint which includes TEE status
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/index.js';
import type { Config } from '../../src/config/index.js';

// Mock ioredis
vi.mock('ioredis', () => {
  const mockRedis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    rpop: vi.fn().mockResolvedValue(null),
    rpush: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue('OK'),
    getdel: vi.fn().mockResolvedValue(null),
    status: 'ready',
  };
  return { default: vi.fn(() => mockRedis), Redis: vi.fn(() => mockRedis) };
});

// Mock ethers — include all methods used at module load time
vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
    Wallet: vi.fn().mockImplementation(() => ({ address: '0x' + '11'.repeat(20) })),
    Contract: vi.fn().mockImplementation(() => ({})),
    hexlify: vi.fn((b: any) => '0x00'),
    encodeBytes32String: vi.fn((s: string) => '0x00'),
    id: vi.fn((s: string) => '0x' + '00'.repeat(32)),
    keccak256: vi.fn(() => '0x' + '00'.repeat(32)),
    getBytes: vi.fn(() => new Uint8Array(32)),
    randomBytes: vi.fn(() => new Uint8Array(32)),
  },
}));

// Mock circuit artifact manager
vi.mock('../../src/circuit/artifactManager.js', () => ({
  ensureArtifacts: vi.fn().mockResolvedValue(undefined),
}));

// Mock identity
vi.mock('../../src/identity/autoRegister.js', () => ({
  ensureAgentRegistered: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/identity/reputation.js', () => ({
  handleProofCompleted: vi.fn().mockResolvedValue(undefined),
}));

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
    websiteUrl: 'https://zkproofport.com',
    agentVersion: '1.0.0',
    paymentPayTo: '',
    paymentProofPrice: '$0.10',
    teeMode: 'disabled' as const,
    enclaveCid: undefined,
    enclavePort: 5000,
    teeAttestationEnabled: false,
    erc8004IdentityAddress: '',
    erc8004ReputationAddress: '',
    erc8004ValidationAddress: '',
    openaiApiKey: '',
    geminiApiKey: '',
    phoenixCollectorEndpoint: '',
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

  describe('GET /health', () => {
    it('should return healthy status with disabled TEE mode', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
      expect(response.body.tee).toBeDefined();
      expect(response.body.tee.mode).toBe('disabled');
    });

    it('should include tee.attestationEnabled field', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.tee).toHaveProperty('attestationEnabled');
      expect(typeof response.body.tee.attestationEnabled).toBe('boolean');
    });

    it('should include tee.mode field with valid value', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.tee).toHaveProperty('mode');
      expect(['disabled', 'local', 'nitro']).toContain(response.body.tee.mode);
    });

    it('should include paymentMode field', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('paymentMode');
    });

    it('should return JSON response', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/json/);
    });
  });

  describe('TEE mode variations', () => {
    it('should handle local mode configuration', async () => {
      const originalMode = process.env.TEE_MODE;
      process.env.TEE_MODE = 'local';

      const { app: testApp } = createApp(makeTestConfig({ teeMode: 'local' as const }));

      const response = await request(testApp).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.tee.mode).toBe('local');

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

      const response = await request(testApp).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.tee.mode).toBe('nitro');

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
    it('should have all required fields', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('service');
      expect(response.body).toHaveProperty('tee');
      expect(response.body.tee).toHaveProperty('mode');
      expect(response.body.tee).toHaveProperty('attestationEnabled');
    });

    it('should report service name correctly', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.service).toBe('proofport-ai');
    });
  });
});
