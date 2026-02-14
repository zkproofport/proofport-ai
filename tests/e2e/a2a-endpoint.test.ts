/**
 * A2A Endpoint E2E Tests
 * Tests the full HTTP endpoint flow for Agent-to-Agent protocol
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import type { Config } from '../../src/config/index.js';

// ─── Mock modules ─────────────────────────────────────────────────────────

// Mock x402 payment middleware
vi.mock('@x402/express', () => ({
  paymentMiddleware: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  x402ResourceServer: vi.fn().mockImplementation(() => ({
    register: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('@x402/evm/exact/server', () => ({
  ExactEvmScheme: vi.fn(),
}));

vi.mock('@x402/core/server', () => ({
  HTTPFacilitatorClient: vi.fn(),
}));

// Mock ioredis
vi.mock('ioredis', () => {
  const store = new Map<string, string>();
  const mockRedis = {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) || null)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    rpop: vi.fn().mockResolvedValue(null),
    rpush: vi.fn().mockResolvedValue(1),
    lpush: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue('OK'),
    status: 'ready',
  };
  return { default: vi.fn(() => mockRedis), Redis: vi.fn(() => mockRedis) };
});

// Mock BbProver
vi.mock('../../src/prover/bbProver.js', () => ({
  BbProver: vi.fn().mockImplementation(() => ({
    prove: vi.fn().mockResolvedValue({
      proof: '0xmockproof',
      publicInputs: '0xmockpublic',
      proofWithInputs: '0xmockproofpublic',
    }),
  })),
}));

// Mock inputBuilder
vi.mock('../../src/input/inputBuilder.js', () => ({
  computeCircuitParams: vi.fn().mockResolvedValue({
    signalHash: new Uint8Array(32).fill(1),
    merkleRoot: '0x' + '22'.repeat(32),
    scopeBytes: new Uint8Array(32).fill(3),
    nullifierBytes: new Uint8Array(32).fill(4),
    userAddress: '0x' + '55'.repeat(20),
    userSignature: '0x' + '66'.repeat(65),
    userPubkeyX: '0x' + '77'.repeat(32),
    userPubkeyY: '0x' + '88'.repeat(32),
    rawTxBytes: Array(200).fill(9),
    txLength: 200,
    attesterPubkeyX: '0x' + 'aa'.repeat(32),
    attesterPubkeyY: '0x' + 'bb'.repeat(32),
    merkleProof: ['0x' + 'cc'.repeat(32)],
    merkleLeafIndex: 0,
    merkleDepth: 1,
  }),
}));

// Mock ethers
vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
      getNetwork: vi.fn().mockResolvedValue({ chainId: 84532n }),
    })),
    Wallet: vi.fn().mockImplementation((_pk: string, prov: any) => ({
      address: '0x1234567890123456789012345678901234567890',
      provider: prov,
    })),
    Contract: vi.fn().mockImplementation(() => ({
      verify: vi.fn().mockResolvedValue(true),
      register: vi.fn().mockResolvedValue({ wait: vi.fn().mockResolvedValue({ logs: [] }) }),
      balanceOf: vi.fn().mockResolvedValue(0n),
      incrementScore: vi.fn().mockResolvedValue({ wait: vi.fn().mockResolvedValue({}) }),
    })),
    hexlify: vi.fn((bytes: Uint8Array) => '0x' + Buffer.from(bytes).toString('hex')),
    encodeBytes32String: vi.fn((str: string) => '0x' + Buffer.from(str).toString('hex').padEnd(64, '0')),
  },
}));

// Mock circuit artifact manager
vi.mock('../../src/circuit/artifactManager.js', () => ({
  ensureArtifacts: vi.fn().mockResolvedValue(undefined),
}));

// Mock identity
vi.mock('../../src/identity/autoRegister.js', () => ({
  ensureAgentRegistered: vi.fn().mockResolvedValue(123456n),
}));

vi.mock('../../src/identity/reputation.js', () => ({
  handleProofCompleted: vi.fn().mockResolvedValue(undefined),
}));

// Mock verifier
vi.mock('../../src/prover/verifier.js', () => ({
  verifyOnChain: vi.fn().mockResolvedValue(true),
}));

// Mock contracts config (must be mocked to avoid issues with ERC8004_ADDRESSES)
vi.mock('../../src/config/contracts.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config/contracts.js')>('../../src/config/contracts.js');
  return {
    ...actual,
    ERC8004_ADDRESSES: {
      mainnet: {
        identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
      },
      sepolia: {
        identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      },
    },
  };
});

// ─── Test suite ───────────────────────────────────────────────────────────

describe('A2A Endpoint E2E', () => {
  let app: any;

  beforeEach(() => {
    const testConfig: Config = {
      port: 4002,
      nodeEnv: 'test',
      proverUrl: '',
      bbPath: '/usr/local/bin/bb',
      nargoPath: '/usr/local/bin/nargo',
      circuitsDir: '/circuits',
      circuitsRepoUrl: 'https://example.com/circuits',
      redisUrl: 'redis://localhost:6379',
      baseRpcUrl: 'https://base-rpc.example.com',
      easGraphqlEndpoint: 'https://eas.example.com',
      chainRpcUrl: 'https://chain.example.com',
      nullifierRegistryAddress: '0x' + '11'.repeat(20),
      proverPrivateKey: '0x' + 'ab'.repeat(32),
      paymentMode: 'disabled' as const,
      a2aBaseUrl: 'https://a2a.example.com',
      agentVersion: '1.0.0',
      paymentPayTo: '',
      paymentFacilitatorUrl: '',
      paymentProofPrice: '$0.10',
      privyAppId: '',
      privyApiSecret: '',
      privyApiUrl: '',
      signPageUrl: '',
      signingTtlSeconds: 300,
      teeMode: 'disabled' as const,
      enclaveCid: undefined,
      enclavePort: 5000,
      teeAttestationEnabled: false,
      erc8004IdentityAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      erc8004ReputationAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      settlementChainRpcUrl: '',
      settlementPrivateKey: '',
      settlementOperatorAddress: '',
      settlementUsdcAddress: '',
    };

    const appBundle = createApp(testConfig, 123456n);
    app = appBundle.app;
  });

  describe('GET /.well-known/agent.json', () => {
    it('should return OASF agent with correct structure', async () => {
      const response = await request(app).get('/.well-known/agent.json');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toMatchObject({
        type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        name: 'ZKProofport',
        description: expect.any(String),
        agentType: 'service',
        tags: expect.any(Array),
        services: expect.any(Array),
        active: true,
        supportedTrust: ['reputation'],
      });
    });

    it('should include ERC-8004 identity in agent card', async () => {
      const response = await request(app).get('/.well-known/agent-card.json');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        protocolVersion: '0.3.0',
        preferredTransport: 'JSONRPC',
        provider: {
          organization: 'ZKProofport',
          url: 'https://zkproofport.app',
        },
        capabilities: {
          stateTransitionHistory: true,
        },
        securitySchemes: {
          x402: { scheme: 'x402', description: expect.any(String) },
        },
        identity: {
          erc8004: {
            contractAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
            chainId: expect.any(Number),
            tokenId: '123456',
          },
        },
      });
    });

    it('should list skills with tags and examples', async () => {
      const response = await request(app).get('/.well-known/agent-card.json');

      expect(response.status).toBe(200);
      expect(response.body.skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'generate_proof',
            name: 'Generate ZK Proof',
            tags: expect.any(Array),
            examples: expect.any(Array),
          }),
          expect.objectContaining({
            id: 'verify_proof',
            name: 'Verify ZK Proof',
            tags: expect.any(Array),
            examples: expect.any(Array),
          }),
          expect.objectContaining({
            id: 'get_supported_circuits',
            name: 'Get Supported Circuits',
            tags: expect.any(Array),
            examples: expect.any(Array),
          }),
        ])
      );
    });

    it('should have all required OASF fields', async () => {
      const response = await request(app).get('/.well-known/agent.json');

      expect(response.status).toBe(200);
      const agent = response.body;

      expect(agent).toHaveProperty('type');
      expect(agent).toHaveProperty('name');
      expect(agent).toHaveProperty('description');
      expect(agent).toHaveProperty('agentType');
      expect(agent).toHaveProperty('tags');
      expect(agent).toHaveProperty('services');
      expect(agent).toHaveProperty('active');
      expect(agent).toHaveProperty('supportedTrust');
    });
  });

  describe('POST /a2a (JSON-RPC)', () => {
    it('should accept tasks/get for querying task status', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/get',
          params: {
            id: 'test-task-id-123',
          },
        });

      expect(response.status).toBe(200);
      // Will return task not found error since we didn't create the task
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32001,
          message: 'Task not found',
        },
      });
    });

    it('should return JSON-RPC error for invalid method', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'invalid_method_name',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32601,
          message: expect.stringContaining('Method not found'),
        },
      });
    });

    it('should return JSON-RPC error for missing message param in message/send', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32602,
          message: expect.stringContaining('message with role'),
        },
      });
    });

    it('should return JSON-RPC error for invalid skill value in message', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  mimeType: 'application/json',
                  data: {
                    skill: 'nonexistent_skill',
                  },
                },
              ],
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32602,
          message: expect.stringContaining('Invalid skill'),
        },
      });
    });

    it('should handle malformed JSON-RPC request', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          // Missing jsonrpc field
          id: 1,
          method: 'tasks/send',
          params: { skill: 'generate_proof' },
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        error: expect.objectContaining({
          code: expect.any(Number),
          message: expect.any(String),
        }),
      });
    });
  });


  describe('Status Endpoints', () => {
    it('GET /health should return healthy status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'healthy',
        service: 'proofport-ai',
        paymentMode: 'disabled',
        paymentRequired: false,
      });
    });

    it('GET /payment/status should return payment config', async () => {
      const response = await request(app).get('/payment/status');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        mode: 'disabled',
        requiresPayment: false,
        description: expect.any(String),
      });
    });

    it('GET /signing/status should return signing providers', async () => {
      const response = await request(app).get('/signing/status');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        providers: {
          privy: { enabled: false },
          web: { enabled: false, signPageUrl: null },
          eip7702: { enabled: true },
        },
      });
    });

    it('GET /tee/status should return TEE config', async () => {
      const response = await request(app).get('/tee/status');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        mode: 'disabled',
        attestationEnabled: false,
        available: false,
      });
    });

    it('GET /identity/status should return ERC-8004 config', async () => {
      const response = await request(app).get('/identity/status');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        erc8004: {
          identityContract: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
          reputationContract: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
          configured: true,
        },
      });
    });

    it('should return JSON content-type for all status endpoints', async () => {
      const endpoints = ['/health', '/payment/status', '/signing/status', '/tee/status', '/identity/status'];

      for (const endpoint of endpoints) {
        const response = await request(app).get(endpoint);
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toMatch(/json/);
      }
    });
  });

  describe('Route Coexistence', () => {
    it('A2A and MCP routes both respond correctly', async () => {
      // Test OASF Agent Card
      const oasfResponse = await request(app).get('/.well-known/agent.json');
      expect(oasfResponse.status).toBe(200);
      expect(oasfResponse.body.name).toBe('ZKProofport');

      // Test A2A Agent Card
      const agentCardResponse = await request(app).get('/.well-known/agent-card.json');
      expect(agentCardResponse.status).toBe(200);
      expect(agentCardResponse.body.name).toBe('ZKProofport Prover Agent');
      expect(agentCardResponse.body.preferredTransport).toBe('JSONRPC');

      // Test A2A JSON-RPC (use tasks/get which is non-blocking)
      const a2aResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/get',
          params: { id: 'non-existent-id' },
        });
      expect(a2aResponse.status).toBe(200);
      expect(a2aResponse.body).toHaveProperty('error');

      // Test MCP JSON-RPC
      const mcpResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        });
      expect(mcpResponse.status).toBe(200);
    });
  });
});
