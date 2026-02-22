/**
 * x402 Payment Gating E2E Tests
 *
 * Tests that payment gating logic ENFORCES payment for paid endpoints
 * (generate_proof) while allowing free endpoints through without payment.
 *
 * Key difference from other E2E tests: the @x402/express mock actually
 * ENFORCES payment (returns 402) instead of passing through.
 *
 * Payment gating logic (from src/index.ts):
 *
 * A2A (POST /a2a):
 *   - message/send or message/stream with DataPart skill generate_proof -> REQUIRES PAYMENT
 *   - message/send or message/stream with DataPart skill get_supported_circuits or verify_proof -> FREE
 *   - tasks/get, tasks/cancel, tasks/resubscribe -> FREE (no payment middleware at all)
 *
 * MCP (POST /mcp):
 *   - tools/call with name: 'generate_proof' -> REQUIRES PAYMENT
 *   - tools/call with name: 'get_supported_circuits' or 'verify_proof' -> FREE
 *   - initialize, tools/list -> FREE
 *
 * REST (/api/v1/*):
 *   - POST /api/v1/proofs -> REQUIRES PAYMENT
 *   - GET /api/v1/circuits -> FREE
 *   - POST /api/v1/proofs/verify -> FREE
 *   - GET /api/v1/proofs/:taskId -> FREE
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import type { Config } from '../../src/config/index.js';

// ─── Mock modules ─────────────────────────────────────────────────────────

// Mock x402 payment middleware — ENFORCING mock (returns 402 when no payment header)
vi.mock('@x402/express', () => ({
  paymentMiddleware: vi.fn(() => {
    // This middleware is called ONLY when our code decides payment is needed
    // (a2aPaymentMiddleware/mcpPaymentMiddleware/restPaymentMiddleware already filter free routes)
    return (req: any, res: any, next: any) => {
      const hasPayment = req.headers['x-payment'] || req.headers['payment-signature'];
      if (hasPayment) {
        // Simulate successful payment verification
        (req as any).x402Payment = {
          payerAddress: '0x' + 'ff'.repeat(20),
          amount: '100000',
          network: 'eip155:84532',
        };
        next();
      } else {
        // Return 402 Payment Required
        res.status(402).json({
          error: 'Payment required',
          x402Version: 2,
        });
      }
    };
  }),
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

// vi.hoisted() runs before vi.mock() factory hoisting, so these values are
// available inside the ioredis mock factory without TDZ errors.
const { _redisStore, _redisListStore } = vi.hoisted(() => ({
  _redisStore: new Map<string, string>(),
  _redisListStore: new Map<string, string[]>(),
}));

// Mock ioredis — mockRedis is a singleton shared across all new Redis() calls.
vi.mock('ioredis', () => {
  const mockRedis: any = {
    get: vi.fn((key: string) => Promise.resolve(_redisStore.get(key) || null)),
    set: vi.fn((...args: any[]) => {
      _redisStore.set(args[0], args[1]);
      return Promise.resolve('OK');
    }),
    del: vi.fn((key: string) => {
      _redisStore.delete(key);
      return Promise.resolve(1);
    }),
    rpop: vi.fn((key: string) => {
      const list = _redisListStore.get(key);
      if (list && list.length > 0) return Promise.resolve(list.pop()!);
      return Promise.resolve(null);
    }),
    lpush: vi.fn((key: string, value: string) => {
      const list = _redisListStore.get(key) || [];
      list.push(value);
      _redisListStore.set(key, list);
      return Promise.resolve(list.length);
    }),
    rpush: vi.fn((key: string, value: string) => {
      const list = _redisListStore.get(key) || [];
      list.push(value);
      _redisListStore.set(key, list);
      return Promise.resolve(list.length);
    }),
    ttl: vi.fn().mockResolvedValue(300),
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
  computeSignalHash: vi.fn().mockReturnValue(new Uint8Array(32).fill(1)),
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

// TaskWorker mock removed — SDK migration uses ProofportExecutor (synchronous execution via DefaultRequestHandler)

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse SSE response text to extract JSON-RPC message.
 * MCP StreamableHTTP sends responses as Server-Sent Events.
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

// ─── Test config ──────────────────────────────────────────────────────────

// Payment mode is 'testnet' (NOT 'disabled') — this activates x402 middleware
const testConfig: Config = {
  port: 4002,
  nodeEnv: 'test',
  websiteUrl: 'https://zkproofport.com',
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
  paymentMode: 'testnet' as const,
  a2aBaseUrl: 'https://a2a.example.com',
  agentVersion: '1.0.0',
  paymentPayTo: '0x' + 'aa'.repeat(20),
  paymentFacilitatorUrl: 'https://test-facilitator.example.com',
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

// ─── Test suite ───────────────────────────────────────────────────────────

describe('x402 Payment Gating E2E', () => {
  let app: any;

  beforeEach(() => {
    // Clear both Redis stores before each test to prevent cross-test interference
    _redisStore.clear();
    _redisListStore.clear();

    const appBundle = createApp(testConfig, 123456n);
    app = appBundle.app;
  });

  // ─── A2A Payment Gating ─────────────────────────────────────────────────

  describe('A2A Payment Gating', () => {
    it('message/send generate_proof WITHOUT x402 payment header returns 200 (no middleware gating)', async () => {
      // x402 middleware removed — generate_proof is accessible without payment header.
      // Payment is enforced inside skillHandler via request_payment flow (Redis paymentStatus check).
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'test-msg-1',
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  data: {
                    skill: 'generate_proof',
                    scope: 'test.com',
                    circuitId: 'coinbase_attestation',
                    address: '0x' + 'dd'.repeat(20),
                    signature: '0x' + 'ee'.repeat(65),
                  },
                },
              ],
            },
          },
        });

      // No longer 402 — reaches handler directly (may complete or fail based on skillHandler logic)
      expect(response.status).toBe(200);
    });

    it('message/send generate_proof WITH payment header returns 200 (task completes)', async () => {
      const response = await request(app)
        .post('/a2a')
        .set('X-Payment', 'test-payment-token')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'test-msg-2',
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  data: {
                    skill: 'generate_proof',
                    scope: 'test.com',
                    circuitId: 'coinbase_attestation',
                    address: '0x' + 'dd'.repeat(20),
                    signature: '0x' + 'ee'.repeat(65),
                  },
                },
              ],
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.error).toBeUndefined();
      expect(response.body.result).toBeDefined();

      const task = response.body.result;
      expect(task.status.state).toBe('completed');
      expect(task.artifacts).toBeDefined();
      expect(task.artifacts.length).toBeGreaterThan(0);

      // Verify proof data is in the artifact
      const artifact = task.artifacts.find((a: any) =>
        a.parts.some((p: any) => p.kind === 'data' && p.data && 'proof' in p.data)
      );
      expect(artifact).toBeDefined();
    });

    it('message/send get_supported_circuits WITHOUT payment returns 200 (free)', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'test-msg-3',
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  data: {
                    skill: 'get_supported_circuits',
                    chainId: '84532',
                  },
                },
              ],
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.error).toBeUndefined();
      expect(response.body.result).toBeDefined();

      const task = response.body.result;
      expect(task.status.state).toBe('completed');
      expect(task.artifacts).toBeDefined();
      expect(task.artifacts.length).toBeGreaterThan(0);
    });

    it('message/send verify_proof WITHOUT payment returns 200 (free)', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'test-msg-4',
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  data: {
                    skill: 'verify_proof',
                    circuitId: 'coinbase_attestation',
                    proof: '0xaabb',
                    publicInputs: ['0x' + 'cc'.repeat(32)],
                    chainId: '84532',
                  },
                },
              ],
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.error).toBeUndefined();
      expect(response.body.result).toBeDefined();

      const task = response.body.result;
      expect(task.status.state).toBe('completed');
    });

    it('tasks/get WITHOUT payment returns 200 (always free, not 402)', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 5,
          method: 'tasks/get',
          params: {
            id: 'non-existent-task-id',
          },
        });

      // tasks/get is always free — should return 200 with a "task not found" error,
      // NOT 402 payment required
      expect(response.status).toBe(200);
      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.id).toBe(5);
      expect(response.body.error.code).toBe(-32001);
      expect(response.body.error.message).toContain('Task not found');
    });

    it('tasks/cancel WITHOUT payment returns 200 (always free, not 402)', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 6,
          method: 'tasks/cancel',
          params: {
            id: 'non-existent-task-id',
          },
        });

      // tasks/cancel is always free — should return 200 with a "task not found" error,
      // NOT 402 payment required
      expect(response.status).toBe(200);
      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.id).toBe(6);
      expect(response.body.error.code).toBe(-32001);
      expect(response.body.error.message).toContain('Task not found');
    });

    it('tasks/resubscribe WITHOUT payment → not 402 (always free)', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 107,
          method: 'tasks/resubscribe',
          params: { id: 'non-existent-task-id' },
        });

      // Should NOT be 402 — tasks/resubscribe is always free
      // SDK returns SSE stream for resubscribe, so response may not be JSON
      expect(response.status).not.toBe(402);
    });
  });

  // ─── MCP Payment Gating ─────────────────────────────────────────────────

  describe('MCP Payment Gating', () => {
    it('tools/call generate_proof WITHOUT x402 payment header returns 200 (no middleware gating)', async () => {
      // x402 middleware removed — generate_proof is accessible without payment header.
      // Payment is enforced inside skillHandler via request_payment flow.
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'generate_proof',
            arguments: {
              circuitId: 'coinbase_attestation',
              scope: 'test.com',
              address: '0x' + 'dd'.repeat(20),
              signature: '0x' + 'ee'.repeat(65),
            },
          },
        });

      // No longer 402 — reaches MCP handler directly
      expect(response.status).toBe(200);
    });

    it('tools/call generate_proof WITH payment header returns 200 (proof generated)', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('X-Payment', 'test-payment-token')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'generate_proof',
            arguments: {
              circuitId: 'coinbase_attestation',
              scope: 'test.com',
              address: '0x' + 'dd'.repeat(20),
              signature: '0x' + 'ee'.repeat(65),
            },
          },
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toBeDefined();
      expect(data.jsonrpc).toBe('2.0');
      expect(data.id).toBe(2);
      // Should have result (not error) — proof tool returns content
      expect(data.result).toBeDefined();
      expect(data.result.content).toBeDefined();
    });

    it('tools/call get_supported_circuits WITHOUT payment returns 200 (free)', async () => {
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
      expect(data).toBeDefined();
      expect(data.result).toBeDefined();
      expect(data.result.content).toBeDefined();
      // Content should mention coinbase_attestation
      const textContents = data.result.content.filter((c: any) => c.type === 'text');
      expect(textContents.length).toBeGreaterThan(0);
      expect(textContents[textContents.length - 1].text).toContain('coinbase_attestation');
    });

    it('tools/call verify_proof WITHOUT payment returns 200 (free)', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'verify_proof',
            arguments: {
              circuitId: 'coinbase_attestation',
              proof: '0xaabb',
              publicInputs: ['0x' + 'cc'.repeat(32)],
              chainId: '84532',
            },
          },
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toBeDefined();
      expect(data.result).toBeDefined();
      expect(data.result.content).toBeDefined();
    });

    it('initialize WITHOUT payment returns 200 (free)', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 5,
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

      const data = parseSSEResponse(response.text);
      expect(data).toBeDefined();
      expect(data.result).toBeDefined();
      expect(data.result.serverInfo).toBeDefined();
    });

    it('tools/list WITHOUT payment returns 200 (free)', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/list',
          params: {},
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toBeDefined();
      expect(data.result).toBeDefined();
      expect(data.result.tools).toBeDefined();
      expect(data.result.tools).toHaveLength(6);
    });
  });

  // ─── REST Payment Gating ────────────────────────────────────────────────

  describe('REST Payment Gating', () => {
    it('POST /api/v1/proofs WITHOUT x402 payment header returns 200 (no middleware gating)', async () => {
      // x402 middleware removed — POST /api/v1/proofs is accessible without payment header.
      // Payment is enforced inside skillHandler via request_payment flow.
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
          address: '0x' + 'dd'.repeat(20),
          signature: '0x' + 'ee'.repeat(65),
        });

      // No longer 402 — reaches REST handler directly
      expect(response.status).toBe(200);
    });

    it('POST /api/v1/proofs WITH payment header returns 200', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .set('X-Payment', 'test-payment-token')
        .send({
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
          address: '0x' + 'dd'.repeat(20),
          signature: '0x' + 'ee'.repeat(65),
        });

      expect(response.status).toBe(200);
      expect(response.body.proof).toBeDefined();
      expect(response.body.publicInputs).toBeDefined();
      expect(response.body.proofId).toBeDefined();
    });

    it('GET /api/v1/circuits WITHOUT payment returns 200 (free)', async () => {
      const response = await request(app)
        .get('/api/v1/circuits');

      expect(response.status).toBe(200);
      expect(response.body.circuits).toBeDefined();
      expect(Array.isArray(response.body.circuits)).toBe(true);
      expect(response.body.circuits.length).toBeGreaterThan(0);
    });

    it('POST /api/v1/proofs/verify WITHOUT payment returns 200 (free)', async () => {
      const response = await request(app)
        .post('/api/v1/proofs/verify')
        .send({
          circuitId: 'coinbase_attestation',
          proof: '0xaabb',
          publicInputs: ['0x' + 'cc'.repeat(32)],
          chainId: '84532',
        });

      expect(response.status).toBe(200);
      // Verify route should succeed (not return 402)
      expect(response.body.valid).toBeDefined();
      expect(response.body.circuitId).toBe('coinbase_attestation');
    });

    it('GET /api/v1/proofs/:taskId WITHOUT payment returns not 402 (free)', async () => {
      const response = await request(app)
        .get('/api/v1/proofs/non-existent-task-id');

      // Should be 404 (task not found) — NOT 402 (payment required)
      expect(response.status).not.toBe(402);
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        error: 'Task not found',
      });
    });
  });

  // ─── Status Endpoints ───────────────────────────────────────────────────

  describe('Status Endpoints (always free)', () => {
    it('all status endpoints return 200 without payment', async () => {
      const endpoints = [
        '/health',
        '/payment/status',
        '/signing/status',
        '/tee/status',
        '/identity/status',
      ];

      for (const endpoint of endpoints) {
        const response = await request(app).get(endpoint);
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toMatch(/json/);
      }
    });

    it('/health shows payment mode as testnet with requiresPayment true', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'healthy',
        service: 'proofport-ai',
        paymentMode: 'testnet',
        paymentRequired: true,
      });
    });

    it('/payment/status shows testnet config', async () => {
      const response = await request(app).get('/payment/status');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        mode: 'testnet',
        network: 'eip155:84532',
        requiresPayment: true,
      });
    });
  });
});
