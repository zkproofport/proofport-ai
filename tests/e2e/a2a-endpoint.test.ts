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

// Mock TaskWorker — intercepts task creation via the queue and immediately emits
// task completion so waitForTaskCompletion() resolves without real proof generation.
//
// Strategy: `start()` patches the taskStore's redis lpush so that whenever a task
// is pushed to `a2a:queue:submitted`, the worker immediately processes it in the
// next microtask (after waitForTaskCompletion has registered its listener).
// The mock is skill-aware: it produces correct artifacts per skill and fails on
// missing required parameters, matching the real TaskWorker behavior.
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

                  const skill = task.skill;
                  const params = task.params || {};

                  if (skill === 'get_supported_circuits') {
                    // Return circuits list matching real TaskWorker output
                    await taskStore.addArtifact(value, {
                      id: 'circuits-artifact',
                      mimeType: 'application/json',
                      parts: [
                        { kind: 'text', text: 'Found 2 supported circuits on chain 84532.' },
                        {
                          kind: 'data',
                          mimeType: 'application/json',
                          data: {
                            circuits: [
                              { id: 'coinbase_attestation', displayName: 'Coinbase KYC', description: 'Coinbase identity attestation' },
                              { id: 'coinbase_country_attestation', displayName: 'Coinbase Country', description: 'Coinbase country attestation' },
                            ],
                            chainId: params.chainId || '84532',
                          },
                        },
                      ],
                    });
                    const finalTask = await taskStore.updateTaskStatus(value, 'completed');
                    taskEventEmitter.emitTaskComplete(value, finalTask);
                  } else if (skill === 'verify_proof') {
                    // Check required params
                    if (!params.circuitId || !params.proof || !params.publicInputs) {
                      await taskStore.addArtifact(value, {
                        id: 'error-artifact',
                        mimeType: 'application/json',
                        parts: [{ kind: 'text', text: 'Missing required parameters: circuitId, proof, publicInputs' }],
                      });
                      const failedTask = await taskStore.updateTaskStatus(value, 'failed');
                      taskEventEmitter.emitTaskComplete(value, failedTask);
                      return;
                    }
                    await taskStore.addArtifact(value, {
                      id: 'verify-artifact',
                      mimeType: 'application/json',
                      parts: [
                        { kind: 'text', text: `Proof verification complete: valid (circuit: ${params.circuitId}, chain: ${params.chainId || '84532'}).` },
                        {
                          kind: 'data',
                          mimeType: 'application/json',
                          data: {
                            valid: true,
                            circuitId: params.circuitId,
                            verifierAddress: '0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c',
                            chainId: params.chainId || '84532',
                          },
                        },
                      ],
                    });
                    const finalTask = await taskStore.updateTaskStatus(value, 'completed');
                    taskEventEmitter.emitTaskComplete(value, finalTask);
                  } else if (skill === 'generate_proof') {
                    // Check required params
                    if (!params.scope || !params.circuitId) {
                      await taskStore.addArtifact(value, {
                        id: 'error-artifact',
                        mimeType: 'application/json',
                        parts: [{ kind: 'text', text: 'Missing required parameters: scope, circuitId' }],
                      });
                      const failedTask = await taskStore.updateTaskStatus(value, 'failed');
                      taskEventEmitter.emitTaskComplete(value, failedTask);
                      return;
                    }
                    await taskStore.addArtifact(value, {
                      id: 'proof-artifact',
                      mimeType: 'application/json',
                      parts: [
                        { kind: 'text', text: `Proof generated successfully for circuit ${params.circuitId}.` },
                        {
                          kind: 'data',
                          mimeType: 'application/json',
                          data: {
                            proof: '0xmockproof',
                            publicInputs: '0x' + 'cc'.repeat(32),
                            nullifier: '0x' + 'dd'.repeat(32),
                            signalHash: '0x' + 'ee'.repeat(32),
                          },
                        },
                      ],
                    });
                    const finalTask = await taskStore.updateTaskStatus(value, 'completed');
                    taskEventEmitter.emitTaskComplete(value, finalTask);
                  } else {
                    // Unknown skill — fail
                    await taskStore.addArtifact(value, {
                      id: 'error-artifact',
                      mimeType: 'application/json',
                      parts: [{ kind: 'text', text: `Unknown skill: ${skill}` }],
                    });
                    const failedTask = await taskStore.updateTaskStatus(value, 'failed');
                    taskEventEmitter.emitTaskComplete(value, failedTask);
                  }
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

// ─── Test suite ───────────────────────────────────────────────────────────

describe('A2A Endpoint E2E', () => {
  let app: any;

  beforeEach(() => {
    // Clear both Redis stores before each test to prevent cross-test interference
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
    // Start the task worker — this patches redis.lpush for this test's app instance
    appBundle.taskWorker.start();
  });

  describe('GET /.well-known/agent.json (A2A Agent Card)', () => {
    it('should return A2A v0.3 agent card', async () => {
      const response = await request(app).get('/.well-known/agent.json');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toMatchObject({
        name: 'proveragent.eth',
        protocolVersion: '0.3.0',
        preferredTransport: 'JSONRPC',
        skills: expect.any(Array),
        capabilities: expect.any(Object),
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

    it('should have all required OASF fields at /.well-known/oasf.json', async () => {
      const response = await request(app).get('/.well-known/oasf.json');

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
          method: 'message/send',
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
          web: { enabled: false },
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
      // Test A2A Agent Card at standard URL
      const oasfResponse = await request(app).get('/.well-known/agent.json');
      expect(oasfResponse.status).toBe(200);
      expect(oasfResponse.body.name).toBe('proveragent.eth');
      expect(oasfResponse.body.protocolVersion).toBe('0.3.0');

      // Test A2A Agent Card at alias URL
      const agentCardResponse = await request(app).get('/.well-known/agent-card.json');
      expect(agentCardResponse.status).toBe(200);
      expect(agentCardResponse.body.name).toBe('proveragent.eth');
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

  describe('A2A message/send Success Paths', () => {
    it('message/send with DataPart get_supported_circuits', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 10,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  mimeType: 'application/json',
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

      const artifact = task.artifacts[0];
      // First artifact must have both TextPart and DataPart
      const textPart = artifact.parts.find((p: any) => p.kind === 'text');
      const dataPart = artifact.parts.find((p: any) => p.kind === 'data');
      expect(textPart).toBeDefined();
      expect(dataPart).toBeDefined();

      // DataPart must contain circuits array with coinbase_attestation
      expect(dataPart.data).toBeDefined();
      expect(dataPart.data.circuits).toBeDefined();
      expect(Array.isArray(dataPart.data.circuits)).toBe(true);
      const circuitIds = dataPart.data.circuits.map((c: any) => c.id);
      expect(circuitIds).toContain('coinbase_attestation');
    });

    it('message/send with text inference "list supported circuits"', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 11,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [
                {
                  kind: 'text',
                  text: 'list supported circuits',
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

      const artifact = task.artifacts[0];
      const textPart = artifact.parts.find((p: any) => p.kind === 'text');
      const dataPart = artifact.parts.find((p: any) => p.kind === 'data');
      expect(textPart).toBeDefined();
      expect(dataPart).toBeDefined();
      expect(dataPart.data.circuits).toBeDefined();
      const circuitIds = dataPart.data.circuits.map((c: any) => c.id);
      expect(circuitIds).toContain('coinbase_attestation');
    });

    it('message/send with text inference extracts circuitId and scope', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 16,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ kind: 'text', text: 'coinbase_attestation 서킷의 myapp.com 으로 proof 생성해줘' }],
            },
          },
        });

      expect(response.status).toBe(200);
      const result = response.body.result;
      // Should NOT return "Missing required parameters" since circuitId and scope are extracted from text
      expect(result.status.state).not.toBe('rejected');
      expect(result.status.state).toBe('completed');

      // Artifact must contain proof data (circuitId and scope were correctly extracted)
      const artifact = result.artifacts.find((a: any) =>
        a.parts.some((p: any) => p.kind === 'data' && p.data && 'proof' in p.data)
      );
      expect(artifact).toBeDefined();
      const dataPart = artifact.parts.find((p: any) => p.kind === 'data');
      expect(dataPart.data.proof).toBeDefined();
    });

    it('message/send with DataPart verify_proof', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 12,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  mimeType: 'application/json',
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

      const task = response.body.result;
      expect(task.status.state).toBe('completed');
      expect(task.artifacts).toBeDefined();
      expect(task.artifacts.length).toBeGreaterThan(0);

      // Find artifact with DataPart containing valid: true
      const artifact = task.artifacts.find((a: any) =>
        a.parts.some((p: any) => p.kind === 'data' && p.data && typeof p.data.valid === 'boolean')
      );
      expect(artifact).toBeDefined();
      const dataPart = artifact.parts.find((p: any) => p.kind === 'data');
      expect(dataPart.data.valid).toBe(true);
      expect(dataPart.data.circuitId).toBe('coinbase_attestation');
    });

    it('message/send with DataPart generate_proof (direct signature)', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 13,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  mimeType: 'application/json',
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

      const task = response.body.result;
      expect(task.status.state).toBe('completed');
      expect(task.artifacts).toBeDefined();
      expect(task.artifacts.length).toBeGreaterThan(0);

      // Artifact must contain proof data
      const artifact = task.artifacts.find((a: any) =>
        a.parts.some((p: any) => p.kind === 'data' && p.data && 'proof' in p.data)
      );
      expect(artifact).toBeDefined();
      const dataPart = artifact.parts.find((p: any) => p.kind === 'data');
      expect(dataPart.data.proof).toBeDefined();
      expect(dataPart.data.publicInputs).toBeDefined();
    });

    it('message/send with generate_proof missing params', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 14,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  mimeType: 'application/json',
                  data: {
                    skill: 'generate_proof',
                    // no scope, no circuitId
                  },
                },
              ],
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.error).toBeUndefined();

      const task = response.body.result;
      expect(task.status.state).toBe('failed');
      expect(task.artifacts).toBeDefined();
      expect(task.artifacts.length).toBeGreaterThan(0);

      // Error artifact must mention missing parameters
      const errorArtifact = task.artifacts[0];
      const textPart = errorArtifact.parts.find((p: any) => p.kind === 'text');
      expect(textPart).toBeDefined();
      expect(textPart.text).toContain('Missing required parameters: scope, circuitId');
    });

    it('message/send with verify_proof missing params', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 15,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  mimeType: 'application/json',
                  data: {
                    skill: 'verify_proof',
                    // no circuitId, no proof, no publicInputs
                  },
                },
              ],
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.error).toBeUndefined();

      const task = response.body.result;
      expect(task.status.state).toBe('failed');
      expect(task.artifacts).toBeDefined();
      expect(task.artifacts.length).toBeGreaterThan(0);

      const errorArtifact = task.artifacts[0];
      const textPart = errorArtifact.parts.find((p: any) => p.kind === 'text');
      expect(textPart).toBeDefined();
      expect(textPart.text).toContain('Missing required parameters');
    });
  });

  describe('A2A Protocol Compliance (v0.3)', () => {
    it('tasks/cancel returns error for non-existent task', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 20,
          method: 'tasks/cancel',
          params: {
            id: 'non-existent-task-id-xyz',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 20,
        error: {
          code: -32001,
          message: 'Task not found',
        },
      });
    });

    it('tasks/resubscribe returns error for non-existent task', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 21,
          method: 'tasks/resubscribe',
          params: {
            id: 'non-existent-task-id-xyz',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 21,
        error: {
          code: -32001,
          message: 'Task not found',
        },
      });
    });

    it('Task lifecycle states follow A2A spec', async () => {
      // Step 1: Create a task via message/send
      const sendResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 22,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  mimeType: 'application/json',
                  data: {
                    skill: 'get_supported_circuits',
                    chainId: '84532',
                  },
                },
              ],
            },
          },
        });

      expect(sendResponse.status).toBe(200);
      expect(sendResponse.body.error).toBeUndefined();
      const completedTask = sendResponse.body.result;
      expect(completedTask.id).toBeDefined();

      // Step 2: Query the task by ID using tasks/get
      const getResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 23,
          method: 'tasks/get',
          params: {
            id: completedTask.id,
          },
        });

      expect(getResponse.status).toBe(200);
      expect(getResponse.body.error).toBeUndefined();

      const fetchedTask = getResponse.body.result;
      // Must have required A2A task fields
      expect(fetchedTask.id).toBe(completedTask.id);
      expect(fetchedTask.status).toBeDefined();
      expect(fetchedTask.status.state).toBe('completed');
      expect(fetchedTask.status.timestamp).toBeDefined();
      expect(fetchedTask.artifacts).toBeDefined();
      expect(fetchedTask.history).toBeDefined();
      expect(Array.isArray(fetchedTask.history)).toBe(true);
    });

    it('Agent card has required A2A v0.3 fields', async () => {
      const response = await request(app).get('/.well-known/agent-card.json');

      expect(response.status).toBe(200);
      const card = response.body;

      // Required A2A v0.3 top-level fields
      expect(card).toHaveProperty('name');
      expect(card).toHaveProperty('description');
      expect(card).toHaveProperty('url');
      expect(card).toHaveProperty('protocolVersion', '0.3.0');
      expect(card).toHaveProperty('preferredTransport', 'JSONRPC');
      expect(card).toHaveProperty('capabilities');
      expect(card).toHaveProperty('skills');
      expect(Array.isArray(card.skills)).toBe(true);

      // Each skill must have id, name, description
      for (const skill of card.skills) {
        expect(skill).toHaveProperty('id');
        expect(skill).toHaveProperty('name');
        expect(skill).toHaveProperty('description');
      }
    });

    it('contextId flows through as session_id without causing errors', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 25,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              contextId: 'test-ctx-123',
              parts: [
                {
                  kind: 'data',
                  mimeType: 'application/json',
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
      const task = response.body.result;
      expect(task.status.state).toBe('completed');
    });
  });

  describe('ERC-8004 Identity', () => {
    it('Agent card includes ERC-8004 identity block', async () => {
      const response = await request(app).get('/.well-known/agent-card.json');

      expect(response.status).toBe(200);
      const card = response.body;

      expect(card.identity).toBeDefined();
      expect(card.identity.erc8004).toBeDefined();
      expect(card.identity.erc8004).toHaveProperty('contractAddress');
      expect(card.identity.erc8004).toHaveProperty('chainId');
      expect(card.identity.erc8004).toHaveProperty('tokenId');

      // contractAddress must be a valid hex address
      expect(card.identity.erc8004.contractAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      // chainId must be a number
      expect(typeof card.identity.erc8004.chainId).toBe('number');
    });

    it('OASF agent descriptor has ERC-8004 registration fields', async () => {
      const response = await request(app).get('/.well-known/oasf.json');

      expect(response.status).toBe(200);
      const oasf = response.body;

      // registrations array must exist (may be empty if tokenId is null)
      expect(oasf).toHaveProperty('registrations');
      expect(Array.isArray(oasf.registrations)).toBe(true);

      // When tokenId is provided (123456n in test), registrations must be non-empty
      expect(oasf.registrations.length).toBeGreaterThan(0);
      const reg = oasf.registrations[0];
      expect(reg).toHaveProperty('agentRegistry');
      expect(reg).toHaveProperty('agentId');
    });

    it('Identity status endpoint returns ERC-8004 contracts', async () => {
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

    it('Agent card supportedTrust includes reputation (and tee-attestation when TEE enabled)', async () => {
      const response = await request(app).get('/.well-known/oasf.json');

      expect(response.status).toBe(200);
      const oasf = response.body;

      expect(oasf).toHaveProperty('supportedTrust');
      expect(Array.isArray(oasf.supportedTrust)).toBe(true);
      expect(oasf.supportedTrust.length).toBeGreaterThan(0);
      // In disabled TEE mode (test config), only 'reputation' should be present
      expect(oasf.supportedTrust).toContain('reputation');
    });
  });
});
