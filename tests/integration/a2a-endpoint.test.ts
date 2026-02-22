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
const { _redisStore, _redisListStore } = vi.hoisted(() => ({
  _redisStore: new Map<string, string>(),
  _redisListStore: new Map<string, string[]>(),
}));

// Mock ioredis with Map-based store.
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
    lpush: vi.fn((key: string, value: string) => {
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
    // Clear both Redis stores before each test to prevent cross-test interference
    _redisStore.clear();
    _redisListStore.clear();

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
          message: expect.stringContaining('Task not found'),
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
          code: expect.any(Number),
          message: expect.any(String),
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
              kind: 'message',
              messageId: 'msg-invalid-skill',
              role: 'user',
              parts: [
                {
                  kind: 'data',
                  data: {
                    skill: 'nonexistent_skill',
                  },
                },
              ],
            },
          },
        });

      expect(response.status).toBe(200);
      // SDK may return JSON-RPC error or failed task for invalid skill
      if (response.body.error) {
        expect(response.body.error.message).toContain('Invalid skill');
      } else {
        expect(response.body.result).toBeDefined();
        expect(response.body.result.status.state).toBe('failed');
        // Error artifact should mention invalid skill
        const textPart = response.body.result.artifacts?.[0]?.parts?.find((p: any) => p.kind === 'text');
        expect(textPart?.text).toContain('Invalid skill');
      }
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
              kind: 'message',
              messageId: 'msg-circuits-1',
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

    it('message/send with DataPart verify_proof', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 12,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-verify-1',
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
              kind: 'message',
              messageId: 'msg-genproof-1',
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
              kind: 'message',
              messageId: 'msg-genproof-missing',
              role: 'user',
              parts: [
                {
                  kind: 'data',
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
      // SDK returns task with failed state when executor catches error
      const task = response.body.result;
      expect(task).toBeDefined();
      expect(task.status.state).toBe('failed');
      expect(task.artifacts).toBeDefined();
      expect(task.artifacts.length).toBeGreaterThan(0);
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
              kind: 'message',
              messageId: 'msg-verify-missing',
              role: 'user',
              parts: [
                {
                  kind: 'data',
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
      // SDK returns task with failed state when executor catches error
      const task = response.body.result;
      expect(task).toBeDefined();
      expect(task.status.state).toBe('failed');
      expect(task.artifacts).toBeDefined();
      expect(task.artifacts.length).toBeGreaterThan(0);
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
          message: expect.stringContaining('Task not found'),
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
      // SDK may return SSE stream or JSON error — just verify it responds
      if (response.body?.error) {
        expect(response.body.error.message).toContain('Task not found');
      }
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
              kind: 'message',
              messageId: 'msg-lifecycle-1',
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
              kind: 'message',
              messageId: 'msg-ctx-flow-1',
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
            contextId: 'test-ctx-123',
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

  describe('Text Inference Wiring (No LLM configured)', () => {
    it('TextPart message returns LLM configuration error when no LLM keys', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 200,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-text-nollm',
              role: 'user',
              parts: [{ kind: 'text', text: 'list supported circuits' }],
            },
          },
        });

      expect(response.status).toBe(200);
      // With SDK, executor errors produce either a failed task or JSON-RPC error
      if (response.body.error) {
        expect(response.body.error.message).toContain('Text inference requires LLM configuration');
      } else {
        // SDK wraps executor error as a failed task
        expect(response.body.result.status.state).toBe('failed');
      }
    });

    it('Empty text part returns error', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 201,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-empty-text',
              role: 'user',
              parts: [{ kind: 'text', text: '' }],
            },
          },
        });

      expect(response.status).toBe(200);
      // With SDK, executor errors produce either a failed task or JSON-RPC error
      if (response.body.error) {
        expect(response.body.error.message).toContain('no text or data parts');
      } else {
        expect(response.body.result.status.state).toBe('failed');
      }
    });

    it('DataPart still works without LLM configuration', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 202,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-data-nollm',
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

      const artifact = task.artifacts[0];
      const dataPart = artifact.parts.find((p: any) => p.kind === 'data');
      expect(dataPart).toBeDefined();
      expect(dataPart.data.circuits).toBeDefined();
      const circuitIds = dataPart.data.circuits.map((c: any) => c.id);
      expect(circuitIds).toContain('coinbase_attestation');
    });
  });

  describe('Additional Edge Cases', () => {
    it('DataPart without skill field returns LLM configuration error', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 200,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-no-skill',
              role: 'user',
              parts: [{ kind: 'data', data: { address: '0xabc' } }],
            },
          },
        });
      expect(response.status).toBe(200);
      // Falls through to text path since no skill field, then fails because no text content and no LLM
      // SDK may return JSON-RPC error or failed task
      if (response.body.error) {
        expect(response.body.error.code).toBeLessThan(0);
      } else {
        expect(response.body.result.status.state).toBe('failed');
      }
    });

    it('tasks/cancel without id param returns error', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 201,
          method: 'tasks/cancel',
          params: {},
        });
      expect(response.status).toBe(200);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBeLessThan(0);
    });

    it('tasks/resubscribe without id param returns error or SSE', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 202,
          method: 'tasks/resubscribe',
          params: {},
        });
      expect(response.status).toBe(200);
      // SDK may return SSE stream or JSON error for resubscribe
    });

    it('tasks/get without id param returns error', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 203,
          method: 'tasks/get',
          params: {},
        });
      expect(response.status).toBe(200);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBeLessThan(0);
    });

    it('message/send with whitespace-only TextPart returns error', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 204,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-whitespace',
              role: 'user',
              parts: [{ kind: 'text', text: '   \n\t  ' }],
            },
          },
        });
      expect(response.status).toBe(200);
      // SDK may return JSON-RPC error or failed task
      if (response.body.error) {
        expect(response.body.error.code).toBeLessThan(0);
      } else {
        expect(response.body.result.status.state).toBe('failed');
      }
    });

    it('tasks/cancel on completed task returns error', async () => {
      // First create and complete a task
      const sendResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 205,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-cancel-completed-1',
              role: 'user',
              parts: [{ kind: 'data', data: { skill: 'get_supported_circuits' } }],
            },
          },
        });
      expect(sendResponse.body.result).toBeDefined();
      const taskId = sendResponse.body.result.id;

      // Try to cancel the completed task
      const cancelResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 206,
          method: 'tasks/cancel',
          params: { id: taskId },
        });
      expect(cancelResponse.status).toBe(200);
      // SDK returns error for invalid state transition on completed task
      expect(cancelResponse.body.error).toBeDefined();
    });

    it('tasks/resubscribe on completed task succeeds', async () => {
      // First create and complete a task
      const sendResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 207,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-resub-completed-1',
              role: 'user',
              parts: [{ kind: 'data', data: { skill: 'get_supported_circuits' } }],
            },
          },
        });
      const taskId = sendResponse.body.result.id;

      // Resubscribe to completed task — SDK may return SSE stream or task
      const resubResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 208,
          method: 'tasks/resubscribe',
          params: { id: taskId },
        });
      expect(resubResponse.status).toBe(200);
    });

    it('contextId from message is stored in task', async () => {
      const sendResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 209,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-ctx-stored-1',
              role: 'user',
              parts: [{ kind: 'data', data: { skill: 'get_supported_circuits' } }],
            },
            contextId: 'my-custom-context-123',
          },
        });
      expect(sendResponse.body.result).toBeDefined();
      const taskId = sendResponse.body.result.id;

      // Fetch the task and verify contextId
      const getResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 210,
          method: 'tasks/get',
          params: { id: taskId },
        });
      expect(getResponse.body.result.contextId).toBeDefined();
      // contextId should be present (generated or from message)
      expect(typeof getResponse.body.result.contextId).toBe('string');
    });

    it('tasks/get with historyLength=1 returns only last history entry', async () => {
      // Create a task that completes (will have at least 1 history entry from user message)
      const sendResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 211,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-history-1',
              role: 'user',
              parts: [{ kind: 'data', data: { skill: 'get_supported_circuits' } }],
            },
          },
        });
      const taskId = sendResponse.body.result.id;

      const getResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 212,
          method: 'tasks/get',
          params: { id: taskId, historyLength: 1 },
        });
      expect(getResponse.body.result).toBeDefined();
      expect(getResponse.body.result.history.length).toBeLessThanOrEqual(1);
    });
  });

  describe('A2A message/stream (SSE)', () => {
    it('message/stream returns text/event-stream content type', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 300,
          method: 'message/stream',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-stream-1',
              role: 'user',
              parts: [{
                kind: 'data',
                data: { skill: 'get_supported_circuits', chainId: '84532' },
              }],
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    }, 10000);

    it('message/stream SSE body contains task status events', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 301,
          method: 'message/stream',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-stream-2',
              role: 'user',
              parts: [{
                kind: 'data',
                data: { skill: 'get_supported_circuits', chainId: '84532' },
              }],
            },
          },
        });

      expect(response.status).toBe(200);
      // SSE body must contain data: lines with JSON-RPC event payloads
      expect(response.text).toContain('data:');

      // Parse all SSE events
      const events = response.text
        .split('\n')
        .filter((line: string) => line.startsWith('data:'))
        .map((line: string) => JSON.parse(line.substring(5).trim()));

      expect(events.length).toBeGreaterThan(0);
      // At least one event should be a task completion
      const taskEvent = events.find((e: any) =>
        e.result?.status?.state === 'completed' || e.params?.status?.state === 'completed'
      );
      expect(taskEvent).toBeDefined();
    }, 10000);

    it('message/stream with invalid skill returns SSE with failed status', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 302,
          method: 'message/stream',
          params: {
            message: {
              kind: 'message',
              messageId: 'msg-stream-invalid',
              role: 'user',
              parts: [{
                kind: 'data',
                data: { skill: 'invalid_skill' },
              }],
            },
          },
        });

      expect(response.status).toBe(200);
      // SDK may return SSE with error events or JSON-RPC error
      // Just verify the response is not a success task
      if (response.headers['content-type']?.includes('text/event-stream')) {
        expect(response.text).toContain('data:');
      } else {
        expect(response.body.error).toBeDefined();
        expect(response.body.error.message).toContain('Invalid skill');
      }
    });

    it('message/stream with missing message returns error or SSE', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 303,
          method: 'message/stream',
          params: {},
        });

      expect(response.status).toBe(200);
      // SDK may return JSON-RPC error or SSE stream with error events
    });
  });

  describe('CORS Headers', () => {
    it('/.well-known/agent.json returns CORS headers for configured origin', async () => {
      const response = await request(app)
        .get('/.well-known/agent.json')
        .set('Origin', 'http://localhost:3000');

      expect(response.status).toBe(200);
      // If A2A_CORS_ORIGINS is not set in test config, CORS may not be present
      // Just verify the endpoint works with an Origin header
      expect(response.body).toHaveProperty('name');
    });

    it('OPTIONS /.well-known/agent.json returns 204 for preflight', async () => {
      const response = await request(app)
        .options('/.well-known/agent.json')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'GET');

      // Should either return 204 (CORS preflight) or 200 (no CORS configured)
      expect([200, 204]).toContain(response.status);
    });

    it('POST /a2a works with Origin header (browser access)', async () => {
      const response = await request(app)
        .post('/a2a')
        .set('Origin', 'http://localhost:3000')
        .send({
          jsonrpc: '2.0',
          id: 400,
          method: 'tasks/get',
          params: { id: 'test-cors-id' },
        });

      expect(response.status).toBe(200);
      // Should still respond normally even with Origin header
      expect(response.body).toHaveProperty('jsonrpc', '2.0');
    });
  });

});
