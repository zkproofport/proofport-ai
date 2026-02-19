/**
 * REST API Endpoint E2E Tests
 * Tests the full HTTP endpoint flow for /api/v1/ REST routes
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

// vi.hoisted() runs before vi.mock() factory hoisting, so these values are
// available inside the ioredis mock factory without TDZ errors.
const { _redisStore, _redisListStore, _mockRedisHolder } = vi.hoisted(() => ({
  _redisStore: new Map<string, string>(),
  _redisListStore: new Map<string, string[]>(),
  _mockRedisHolder: { instance: null as any },
}));

// Mock ioredis with list operation support (task queue uses lpush/rpop).
// mockRedis is a singleton — all new Redis() calls return the same object.
// beforeEach restores redis.lpush to the original vi.fn after TaskWorker.start()
// patches it, preventing stale closure accumulation across tests.
vi.mock('ioredis', () => {
  const _lpushOriginal = vi.fn((key: string, value: string) => {
    const list = _redisListStore.get(key) || [];
    list.push(value);
    _redisListStore.set(key, list);
    return Promise.resolve(list.length);
  });

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
    lpush: _lpushOriginal,
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
    // Store original lpush so beforeEach can restore it after each test patches it
    _originalLpushFn: _lpushOriginal,
  };
  _mockRedisHolder.instance = mockRedis;
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
  verifyOnChain: vi.fn().mockResolvedValue({
    isValid: true,
    verifierAddress: '0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c',
  }),
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

// Mock TaskWorker — intercepts task creation via the queue and immediately emits
// task completion so waitForTaskCompletion() resolves without real proof generation.
//
// Strategy: `start()` patches the taskStore's redis lpush so that whenever a task
// is pushed to `a2a:queue:submitted`, the worker immediately processes it in the
// next microtask (after waitForTaskCompletion has registered its listener).
vi.mock('../../src/a2a/taskWorker.js', () => {
  return {
    TaskWorker: vi.fn().mockImplementation((deps: any) => {
      return {
        start: vi.fn(() => {
          const { taskStore, taskEventEmitter } = deps;
          const redis = (taskStore as any).redis;
          const originalLpush = redis.lpush.bind(redis);
          redis.lpush = async (key: string, value: string) => {
            const result = await originalLpush(key, value);
            if (key === 'a2a:queue:submitted') {
              setImmediate(async () => {
                try {
                  const task = await taskStore.getTask(value);
                  if (!task || task.status.state !== 'queued') return;
                  await taskStore.updateTaskStatus(value, 'running');
                  await taskStore.addArtifact(value, {
                    id: 'proof-artifact',
                    mimeType: 'application/json',
                    parts: [
                      {
                        kind: 'data',
                        mimeType: 'application/json',
                        data: {
                          proof: '0xmockproof',
                          publicInputs: '0x' + 'cc'.repeat(32),
                          nullifier: '0x' + 'dd'.repeat(32),
                          signalHash: '0x' + 'ee'.repeat(32),
                          valid: true,
                        },
                      },
                    ],
                  });
                  const finalTask = await taskStore.updateTaskStatus(value, 'completed');
                  taskEventEmitter.emitTaskComplete(value, finalTask);
                } catch (err) {
                  console.error('[TaskWorker mock] setImmediate error:', err);
                }
              });
            }
            return result;
          };
        }),
        stop: vi.fn(),
      };
    }),
  };
});

// ─── Test config ───────────────────────────────────────────────────────────

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

// ─── Test suite ───────────────────────────────────────────────────────────

describe('REST API Endpoint E2E', () => {
  let app: any;

  beforeEach(() => {
    // Clear in-memory stores between tests
    _redisStore.clear();
    _redisListStore.clear();

    // Restore the original lpush vi.fn on the shared mockRedis singleton.
    // Each test's TaskWorker.start() patches redis.lpush with a new async wrapper
    // that closes over that test's taskStore/taskEventEmitter. Without this restore,
    // wrappers accumulate and inner closures reference stale instances from previous
    // tests, causing waitForTaskCompletion() to never receive the completion event.
    if (_mockRedisHolder.instance?._originalLpushFn) {
      _mockRedisHolder.instance.lpush = _mockRedisHolder.instance._originalLpushFn;
    }

    const appBundle = createApp(testConfig, 123456n);
    app = appBundle.app;
    // Start the task worker — this patches redis.lpush for this test's app instance
    appBundle.taskWorker.start();
  });

  // ─── GET /api/v1/circuits ───────────────────────────────────────────────

  describe('GET /api/v1/circuits', () => {
    it('returns list of supported circuits', async () => {
      const response = await request(app).get('/api/v1/circuits');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('circuits');
      expect(Array.isArray(response.body.circuits)).toBe(true);

      const ids = response.body.circuits.map((c: any) => c.id);
      expect(ids).toContain('coinbase_attestation');
      expect(ids).toContain('coinbase_country_attestation');
    });

    it('each circuit has required fields', async () => {
      const response = await request(app).get('/api/v1/circuits');

      expect(response.status).toBe(200);
      for (const circuit of response.body.circuits) {
        expect(circuit).toHaveProperty('id');
        expect(circuit).toHaveProperty('displayName');
        expect(circuit).toHaveProperty('description');
        expect(circuit).toHaveProperty('verifierAddress');
        expect(circuit).toHaveProperty('requiredInputs');
        expect(typeof circuit.id).toBe('string');
        expect(typeof circuit.displayName).toBe('string');
        expect(typeof circuit.description).toBe('string');
        expect(Array.isArray(circuit.requiredInputs)).toBe(true);
      }
    });

    it('accepts chainId query parameter', async () => {
      const response = await request(app).get('/api/v1/circuits?chainId=84532');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('circuits');
      expect(Array.isArray(response.body.circuits)).toBe(true);
    });
  });

  // ─── POST /api/v1/proofs ───────────────────────────────────────────────

  describe('POST /api/v1/proofs', () => {
    it('generates proof with direct signature', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('taskId');
      expect(response.body).toHaveProperty('state', 'completed');
    }, 10000);

    it('returns error for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(typeof response.body.error).toBe('string');
    });

    it('returns error for missing scope', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({ circuitId: 'coinbase_attestation' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('scope');
    });

    it('returns error for unknown circuit', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'nonexistent_circuit',
          scope: 'test.com',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('nonexistent_circuit');
    });

    it('returns input-required with signingUrl when no address or signature', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('state', 'input-required');
      expect(response.body).toHaveProperty('signingUrl');
      expect(response.body).toHaveProperty('requestId');
      expect(typeof response.body.signingUrl).toBe('string');
    });

    it('returns error for coinbase_country_attestation missing countryList', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_country_attestation',
          scope: 'test.com',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('countryList');
    });
  });

  // ─── POST /api/v1/proofs/verify ────────────────────────────────────────

  describe('POST /api/v1/proofs/verify', () => {
    it('verifies proof on-chain and returns response with valid field', async () => {
      const response = await request(app)
        .post('/api/v1/proofs/verify')
        .send({
          circuitId: 'coinbase_attestation',
          proof: '0xaabb',
          publicInputs: ['0x' + 'cc'.repeat(32)],
          chainId: '84532',
        });

      // Should respond with 200 containing verification result
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('circuitId', 'coinbase_attestation');
      expect(response.body).toHaveProperty('chainId', '84532');
      expect(response.body).toHaveProperty('verifierAddress');
      expect(typeof response.body.valid).toBe('boolean');
    }, 10000);

    it('returns 400 for missing circuitId', async () => {
      const response = await request(app)
        .post('/api/v1/proofs/verify')
        .send({
          proof: '0xaabb',
          publicInputs: ['0x' + 'cc'.repeat(32)],
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('circuitId');
    });

    it('returns 400 for missing proof', async () => {
      const response = await request(app)
        .post('/api/v1/proofs/verify')
        .send({
          circuitId: 'coinbase_attestation',
          publicInputs: ['0x' + 'cc'.repeat(32)],
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('proof');
    });

    it('returns 400 for missing publicInputs', async () => {
      const response = await request(app)
        .post('/api/v1/proofs/verify')
        .send({
          circuitId: 'coinbase_attestation',
          proof: '0xaabb',
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('publicInputs');
    });

    it('returns 400 for unknown circuit', async () => {
      const response = await request(app)
        .post('/api/v1/proofs/verify')
        .send({
          circuitId: 'nonexistent_circuit',
          proof: '0xaabb',
          publicInputs: ['0x' + 'cc'.repeat(32)],
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('nonexistent_circuit');
    });
  });

  // ─── GET /api/v1/proofs/:taskId ────────────────────────────────────────

  describe('GET /api/v1/proofs/:taskId', () => {
    it('returns 404 for non-existent task', async () => {
      const response = await request(app).get('/api/v1/proofs/non-existent-task-id-12345');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('not found');
    });
  });

  // ─── Discovery Endpoints ───────────────────────────────────────────────

  describe('Discovery Endpoints', () => {
    it('GET /.well-known/mcp.json returns MCP discovery', async () => {
      const response = await request(app).get('/.well-known/mcp.json');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toHaveProperty('tools');
      expect(Array.isArray(response.body.tools)).toBe(true);
    });

    it('GET /docs returns Swagger UI', async () => {
      const response = await request(app).get('/docs');

      // Swagger UI serves HTML (200) or redirects to /docs/ (301/302)
      expect([200, 301, 302]).toContain(response.status);
    });

    it('GET /openapi.json returns OpenAPI spec', async () => {
      const response = await request(app).get('/openapi.json');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toHaveProperty('openapi');
    });
  });

  // ─── Deprecated Endpoints ──────────────────────────────────────────────

  describe('Deprecated Endpoints', () => {
    it('POST /api/v1/chat returns 410 Gone', async () => {
      const response = await request(app)
        .post('/api/v1/chat')
        .send({ message: 'hello' });

      expect(response.status).toBe(410);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('type', 'gone');
      expect(response.body.error).toHaveProperty('code', 'endpoint_removed');
    });
  });
});
