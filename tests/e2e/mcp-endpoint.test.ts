/**
 * MCP Endpoint E2E Tests
 * Tests the full HTTP endpoint flow for MCP (POST /mcp)
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
  ensureAgentRegistered: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/identity/reputation.js', () => ({
  handleProofCompleted: vi.fn().mockResolvedValue(undefined),
}));

// Mock verifier
vi.mock('../../src/prover/verifier.js', () => ({
  verifyOnChain: vi.fn().mockResolvedValue(true),
}));

// Mock contracts config
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

/**
 * Parse SSE response text to extract JSON-RPC message
 * MCP StreamableHTTP sends responses as Server-Sent Events
 */
function parseSSEResponse(text: string): any {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.substring(6));
    }
  }
  return null;
}

describe('MCP Endpoint E2E', () => {
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

    const appBundle = createApp(testConfig);
    app = appBundle.app;
  });

  describe('POST /mcp', () => {
    it('should handle MCP initialize request', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
              name: 'test-client',
              version: '1.0.0',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: expect.any(String),
          capabilities: expect.any(Object),
          serverInfo: expect.objectContaining({
            name: 'zkproofport-prover',
            version: expect.any(String),
          }),
        },
      });
    });

    it('should handle tools/list request', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({
              name: 'generate_proof',
              description: expect.any(String),
              inputSchema: expect.any(Object),
            }),
            expect.objectContaining({
              name: 'verify_proof',
              description: expect.any(String),
              inputSchema: expect.any(Object),
            }),
            expect.objectContaining({
              name: 'get_supported_circuits',
              description: expect.any(String),
              inputSchema: expect.any(Object),
            }),
          ]),
        },
      });

      // Verify all three tools are present
      const tools = data.result.tools;
      expect(tools).toHaveLength(3);
      expect(tools.map((t: any) => t.name).sort()).toEqual([
        'generate_proof',
        'get_supported_circuits',
        'verify_proof',
      ]);
    });

    it('should reject malformed MCP request (invalid JSON-RPC)', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          // Missing jsonrpc field
          id: 1,
          method: 'initialize',
          params: {},
        });

      // Malformed JSON-RPC returns 400
      expect(response.status).toBe(400);
    });

    it('should reject invalid method', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'invalid_method_does_not_exist',
          params: {},
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({
        jsonrpc: '2.0',
        error: {
          code: -32601,
          message: expect.stringContaining('Method not found'),
        },
      });
    });

    it('should handle tools/call for get_supported_circuits', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'get_supported_circuits',
            arguments: {},
          },
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({
        jsonrpc: '2.0',
        id: 3,
        result: {
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'text',
              text: expect.stringContaining('coinbase_attestation'),
            }),
          ]),
        },
      });
    });
  });

  describe('GET /mcp', () => {
    it('should return 405 for GET /mcp', async () => {
      const response = await request(app).get('/mcp');

      expect(response.status).toBe(405);
      expect(response.body).toMatchObject({
        error: expect.stringContaining('SSE not supported'),
      });
    });
  });

  describe('DELETE /mcp', () => {
    it('should return 405 for DELETE /mcp', async () => {
      const response = await request(app).delete('/mcp');

      expect(response.status).toBe(405);
      expect(response.body).toMatchObject({
        error: expect.stringContaining('Session management not supported'),
      });
    });
  });
});
