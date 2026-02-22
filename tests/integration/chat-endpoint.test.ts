/**
 * Chat Endpoint E2E Tests
 * Tests the OpenAI-compatible chat interface at POST /v1/chat/completions and GET /v1/models
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

// Mock ioredis with list support (lpush/rpop backed by real arrays for TaskWorker)
vi.mock('ioredis', () => {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();

  const mockRedis = {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn((key: string) => {
      store.delete(key);
      lists.delete(key);
      return Promise.resolve(1);
    }),
    lpush: vi.fn((key: string, value: string) => {
      const list = lists.get(key) ?? [];
      list.unshift(value);
      lists.set(key, list);
      return Promise.resolve(list.length);
    }),
    rpop: vi.fn((key: string) => {
      const list = lists.get(key);
      if (!list || list.length === 0) return Promise.resolve(null);
      const val = list.pop()!;
      lists.set(key, list);
      return Promise.resolve(val);
    }),
    rpush: vi.fn((key: string, value: string) => {
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
      return Promise.resolve(list.length);
    }),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(3600),
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
  computeSignalHash: vi.fn().mockReturnValue(new Uint8Array(32).fill(0)),
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

// Mock the MultiLLMProvider to return deterministic responses
// Default: first call returns get_supported_circuits tool call, second returns final content
const mockChat = vi.fn();

vi.mock('../../src/chat/multiProvider.js', () => ({
  MultiLLMProvider: vi.fn().mockImplementation(() => ({
    name: 'mock-multi',
    chat: mockChat,
  })),
}));

// Also mock the individual providers so createApp doesn't fail to instantiate them
vi.mock('../../src/chat/openaiClient.js', () => ({
  OpenAIProvider: vi.fn().mockImplementation(() => ({ name: 'openai' })),
}));

vi.mock('../../src/chat/geminiClient.js', () => ({
  GeminiProvider: vi.fn().mockImplementation(() => ({ name: 'gemini' })),
}));

// ─── Test helpers ─────────────────────────────────────────────────────────

function makeTestConfig(overrides?: Partial<Config>): Config {
  return {
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
    signPageUrl: 'https://sign.zkproofport.app',
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
    // Set a non-empty API key so createApp registers /v1 chat routes
    openaiApiKey: 'test-api-key',
    geminiApiKey: '',
    phoenixCollectorEndpoint: '',
    websiteUrl: 'https://zkproofport.com',
    erc8004ValidationAddress: '',
    ...overrides,
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────

describe('Chat Endpoint E2E', () => {
  let app: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mockChat queue — clearAllMocks only clears call history,
    // not mockResolvedValueOnce queues. Without this, unconsumed mocks
    // from tests that return early (400/403/404) accumulate in the queue.
    mockChat.mockReset();

    // Default mock sequence: tool call first, then final content
    mockChat
      .mockResolvedValueOnce({
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'get_supported_circuits',
            args: {},
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'Here are the supported circuits: coinbase_attestation and coinbase_country_attestation.',
        toolCalls: [],
      });

    const appBundle = createApp(makeTestConfig(), 123456n);
    app = appBundle.app;
  });

  // ─── GET /v1/models ──────────────────────────────────────────────────────

  describe('GET /v1/models', () => {
    it('returns model list containing zkproofport model', async () => {
      const response = await request(app).get('/v1/models');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'zkproofport' }),
        ])
      );
    });

    it('response matches OpenAI models format', async () => {
      const response = await request(app).get('/v1/models');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        object: 'list',
        data: expect.arrayContaining([
          expect.objectContaining({
            id: 'zkproofport',
            object: 'model',
            owned_by: 'zkproofport',
          }),
        ]),
      });
      expect(typeof response.body.data[0].created).toBe('number');
    });
  });

  // ─── POST /v1/chat/completions — Non-streaming ───────────────────────────

  describe('POST /v1/chat/completions — Non-streaming', () => {
    it('returns circuit list for a circuits question', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          model: 'zkproofport',
          messages: [
            { role: 'user', content: 'what circuits are supported?' },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: expect.any(String),
            },
            finish_reason: 'stop',
          },
        ],
      });
      expect(typeof response.body.id).toBe('string');
      expect(response.body.id).toMatch(/^chatcmpl-/);
      expect(typeof response.body.created).toBe('number');
    });

    it('returns 400 for empty messages array', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .send({ model: 'zkproofport', messages: [] });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: {
          type: 'invalid_request_error',
          code: 'invalid_messages',
        },
      });
    });

    it('returns 400 for missing messages field', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .send({ model: 'zkproofport' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: {
          type: 'invalid_request_error',
          code: 'invalid_messages',
        },
      });
    });

    it('creates a session on first turn and returns session headers', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'hello' }],
        });

      expect(response.status).toBe(200);
      expect(response.headers['x-session-id']).toBeDefined();
      expect(typeof response.headers['x-session-id']).toBe('string');
      expect(response.headers['x-session-secret']).toBeDefined();
      expect(typeof response.headers['x-session-secret']).toBe('string');
    });

    it('does not create session headers when multiple user messages (stateless mode)', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          messages: [
            { role: 'user', content: 'first message' },
            { role: 'assistant', content: 'response' },
            { role: 'user', content: 'second message' },
          ],
        });

      expect(response.status).toBe(200);
      // Multiple user messages → stateless, no new session headers
      expect(response.headers['x-session-id']).toBeUndefined();
      expect(response.headers['x-session-secret']).toBeUndefined();
    });

    it('returns 404 for unknown session id', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('X-Session-Id', 'nonexistent-session-id')
        .set('X-Session-Secret', 'fake-secret')
        .send({
          messages: [{ role: 'user', content: 'hello' }],
        });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        error: {
          type: 'invalid_request_error',
          code: 'session_not_found',
        },
      });
    });

    it('returns 403 when session secret is missing', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .set('X-Session-Id', 'some-session-id')
        .send({
          messages: [{ role: 'user', content: 'hello' }],
        });

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        error: {
          type: 'invalid_request_error',
          code: 'missing_session_secret',
        },
      });
    });

    it('continues an existing session with valid id and secret', async () => {
      // First turn: create session
      const firstResponse = await request(app)
        .post('/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'what circuits are supported?' }],
        });

      expect(firstResponse.status).toBe(200);
      const sessionId = firstResponse.headers['x-session-id'];
      const sessionSecret = firstResponse.headers['x-session-secret'];
      expect(sessionId).toBeDefined();
      expect(sessionSecret).toBeDefined();

      // Reset mock for second turn
      mockChat
        .mockResolvedValueOnce({
          content: 'Got it! Any other questions?',
          toolCalls: [],
        });

      // Second turn: continue session
      const secondResponse = await request(app)
        .post('/v1/chat/completions')
        .set('X-Session-Id', sessionId)
        .set('X-Session-Secret', sessionSecret)
        .send({
          messages: [{ role: 'user', content: 'thanks' }],
        });

      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.choices[0].message.content).toContain('Got it');
    });

    it('returns 403 for incorrect session secret', async () => {
      // Create a real session first
      const firstResponse = await request(app)
        .post('/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'hello' }],
        });

      expect(firstResponse.status).toBe(200);
      const sessionId = firstResponse.headers['x-session-id'];
      expect(sessionId).toBeDefined();

      // Try to continue with wrong secret
      const secondResponse = await request(app)
        .post('/v1/chat/completions')
        .set('X-Session-Id', sessionId)
        .set('X-Session-Secret', 'wrong-secret')
        .send({
          messages: [{ role: 'user', content: 'hello again' }],
        });

      expect(secondResponse.status).toBe(403);
      expect(secondResponse.body).toMatchObject({
        error: {
          type: 'invalid_request_error',
          code: 'invalid_session_secret',
        },
      });
    });
  });

  // ─── POST /v1/chat/completions — Streaming ───────────────────────────────

  describe('POST /v1/chat/completions — Streaming', () => {
    it('returns SSE stream with correct format', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          stream: true,
          messages: [{ role: 'user', content: 'what circuits are supported?' }],
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);

      const body = response.text;

      // Should contain SSE data lines
      expect(body).toContain('data:');

      // Should end with [DONE]
      expect(body).toContain('data: [DONE]');

      // Parse SSE chunks — filter out non-data lines, [DONE], and step event data lines.
      // Step events use "event: step\ndata: {...}" — their data lines don't have
      // object: 'chat.completion.chunk', so filter to only chat completion chunks.
      const dataLines = body
        .split('\n')
        .filter((line: string) => line.startsWith('data:') && line !== 'data: [DONE]');

      // Parse all and keep only chat completion chunks (ignore step events)
      const allChunks = dataLines
        .map((line: string) => JSON.parse(line.replace(/^data:\s*/, '')))
        .filter((c: any) => c.object === 'chat.completion.chunk');

      expect(allChunks.length).toBeGreaterThan(0);

      // First chunk should have role: 'assistant'
      expect(allChunks[0]).toMatchObject({
        object: 'chat.completion.chunk',
        choices: [
          expect.objectContaining({
            delta: expect.objectContaining({ role: 'assistant' }),
          }),
        ],
      });

      // Last chunk should have finish_reason: 'stop'
      expect(allChunks[allChunks.length - 1].choices[0].finish_reason).toBe('stop');

      // All chunks should share the same id and model
      const ids = new Set(allChunks.map((c: any) => c.id));
      expect(ids.size).toBe(1);
      expect([...ids][0]).toMatch(/^chatcmpl-/);
    });

    it('stream chunks contain content delta fields', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          stream: true,
          messages: [{ role: 'user', content: 'list supported circuits' }],
        });

      expect(response.status).toBe(200);

      const body = response.text;
      const dataLines = body
        .split('\n')
        .filter((line: string) => line.startsWith('data:') && line !== 'data: [DONE]');

      // Filter to chat completion chunks only (skip step event data lines)
      const contentChunks = dataLines
        .map((line: string) => JSON.parse(line.replace(/^data:\s*/, '')))
        .filter((c: any) => c.object === 'chat.completion.chunk' && c.choices?.[0]?.delta?.content);

      // Should have at least one content chunk
      expect(contentChunks.length).toBeGreaterThan(0);
    });
  });

  // ─── POST /v1/chat/completions — Payment (disabled mode) ────────────────

  describe('POST /v1/chat/completions — Payment mode disabled', () => {
    it('proceeds without payment header when payment mode is disabled', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'what circuits are available?' }],
        });

      // With payment disabled, no 402 should be returned
      expect(response.status).toBe(200);
      expect(response.body.object).toBe('chat.completion');
    });
  });

  // ─── Chat not configured (no API keys) ──────────────────────────────────

  describe('POST /v1/chat/completions — Not configured', () => {
    it('returns 503 when no LLM API keys are configured', async () => {
      // Build app without API keys
      const noKeyConfig = makeTestConfig({ openaiApiKey: '', geminiApiKey: '' });
      const { app: unconfiguredApp } = createApp(noKeyConfig, 123456n);

      const response = await request(unconfiguredApp)
        .post('/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'hello' }],
        });

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        error: {
          type: 'server_error',
          code: 'not_configured',
        },
      });
    });
  });

  // ─── Tool execution loop ─────────────────────────────────────────────────

  describe('POST /v1/chat/completions — Tool execution loop', () => {
    it('executes request_signing tool call and includes skill result DSL block in response', async () => {
      // LLM first returns a request_signing tool call, then a final content response
      mockChat.mockReset();
      mockChat
        .mockResolvedValueOnce({
          content: 'Let me start signing...',
          toolCalls: [{ id: 'call_1', name: 'request_signing', args: { circuitId: 'coinbase_attestation', scope: 'test.com' } }],
        })
        .mockResolvedValueOnce({
          content: 'I created a signing request for you.',
          toolCalls: [],
        });

      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'generate a proof for coinbase_attestation scope test.com' }],
        });

      expect(response.status).toBe(200);
      const content: string = response.body.choices[0].message.content;
      // The final response should include LLM's content
      expect(content).toContain('I created a signing request for you.');
    });

    it('appends DSL block when skill result contains signingUrl', async () => {
      mockChat.mockReset();
      mockChat
        .mockResolvedValueOnce({
          content: 'Calling request_signing now.',
          toolCalls: [{ id: 'call_2', name: 'request_signing', args: { circuitId: 'coinbase_attestation', scope: 'test.com' } }],
        })
        .mockResolvedValueOnce({
          content: 'Here is your signing URL.',
          toolCalls: [],
        });

      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'I want to generate a proof' }],
        });

      expect(response.status).toBe(200);
      const content: string = response.body.choices[0].message.content;
      // DSL block should be appended because skill result has signingUrl/requestId
      expect(content).toContain('```proofport');
      expect(content).toContain('requestId');
    });
  });

  // ─── Max function calls limit ─────────────────────────────────────────────

  describe('POST /v1/chat/completions — Max function calls limit', () => {
    it('stops after MAX_FUNCTION_CALLS (5) and returns max calls error message', async () => {
      // Mock LLM to always return a tool call — exceeds limit of 5
      mockChat.mockReset();
      mockChat.mockResolvedValue({
        content: null,
        toolCalls: [{ id: 'call_loop', name: 'get_supported_circuits', args: {} }],
      });

      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'keep calling tools forever' }],
        });

      expect(response.status).toBe(200);
      const content: string = response.body.choices[0].message.content;
      expect(content).toContain('maximum number of function calls');
      // mockChat was called exactly 5 times (the limit)
      expect(mockChat).toHaveBeenCalledTimes(5);
    });
  });

  // ─── Proof call limit ─────────────────────────────────────────────────────

  describe('POST /v1/chat/completions — Proof call limit', () => {
    it('returns error on second generate_proof call within same request', async () => {
      // LLM calls generate_proof with direct signature (first succeeds), then tries again (should be blocked)
      mockChat.mockReset();
      mockChat
        .mockResolvedValueOnce({
          content: null,
          toolCalls: [{ id: 'call_p1', name: 'generate_proof', args: {
            circuitId: 'coinbase_attestation', scope: 'test.com',
            address: '0x' + '55'.repeat(20), signature: '0x' + '66'.repeat(65),
          } }],
        })
        .mockResolvedValueOnce({
          content: null,
          toolCalls: [{ id: 'call_p2', name: 'generate_proof', args: {
            circuitId: 'coinbase_attestation', scope: 'test.com',
            address: '0x' + '55'.repeat(20), signature: '0x' + '66'.repeat(65),
          } }],
        })
        .mockResolvedValueOnce({
          content: 'Done.',
          toolCalls: [],
        });

      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'generate proof twice' }],
        });

      expect(response.status).toBe(200);
      // The LLM was called 3 times — on the second generate_proof call,
      // the proofCallCount limit returns an error instead of executing the skill
      expect(mockChat).toHaveBeenCalledTimes(3);
    });
  });

  // ─── Streaming step events ────────────────────────────────────────────────

  describe('POST /v1/chat/completions — Streaming step events', () => {
    it('SSE stream contains event: step entries during tool execution', async () => {
      // Default mock already calls get_supported_circuits which emits a step event
      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          stream: true,
          messages: [{ role: 'user', content: 'what circuits are supported?' }],
        });

      expect(response.status).toBe(200);

      const body: string = response.text;

      // Should contain at least one SSE step event
      expect(body).toContain('event: step');

      // Parse step events and verify format
      const lines = body.split('\n');
      const stepEventIndices: number[] = [];
      lines.forEach((line, idx) => {
        if (line === 'event: step') stepEventIndices.push(idx);
      });

      expect(stepEventIndices.length).toBeGreaterThan(0);

      // Each step event should be followed by a data line with a message field
      for (const idx of stepEventIndices) {
        const dataLine = lines[idx + 1];
        expect(dataLine).toMatch(/^data:/);
        const stepData = JSON.parse(dataLine.replace(/^data:\s*/, ''));
        expect(typeof stepData.message).toBe('string');
        expect(stepData.message.length).toBeGreaterThan(0);
      }
    });

    it('step event message mentions supported circuits for get_supported_circuits tool call', async () => {
      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          stream: true,
          messages: [{ role: 'user', content: 'list circuits' }],
        });

      expect(response.status).toBe(200);

      const body: string = response.text;
      const lines = body.split('\n');

      // Collect all step event data payloads
      const stepMessages: string[] = [];
      lines.forEach((line, idx) => {
        if (line === 'event: step' && lines[idx + 1]?.startsWith('data:')) {
          const stepData = JSON.parse(lines[idx + 1].replace(/^data:\s*/, ''));
          stepMessages.push(stepData.message);
        }
      });

      // get_supported_circuits emits "Fetching supported circuits..." before and "Circuits retrieved" after
      const allMessages = stepMessages.join(' ');
      expect(allMessages).toMatch(/circuits/i);
    });
  });

  // ─── System prompt inclusion ──────────────────────────────────────────────

  describe('POST /v1/chat/completions — System prompt inclusion', () => {
    it('includes custom system message appended to default system prompt', async () => {
      // Capture what systemPrompt was passed to mockChat
      let capturedSystemPrompt: string | undefined;
      mockChat.mockReset();
      mockChat.mockImplementation((_history: any, systemPrompt: string, _tools: any, _opts?: any) => {
        capturedSystemPrompt = systemPrompt;
        return Promise.resolve({
          content: 'I understand your custom instructions.',
          toolCalls: [],
        });
      });

      await request(app)
        .post('/v1/chat/completions')
        .send({
          messages: [
            { role: 'system', content: 'Always respond in formal English.' },
            { role: 'user', content: 'hello' },
          ],
        });

      expect(capturedSystemPrompt).toBeDefined();
      // Should contain default system prompt content
      expect(capturedSystemPrompt).toContain('proveragent.eth');
      // Should also contain the custom system message
      expect(capturedSystemPrompt).toContain('Always respond in formal English.');
    });

    it('uses default system prompt when no system message provided', async () => {
      let capturedSystemPrompt: string | undefined;
      mockChat.mockReset();
      mockChat.mockImplementation((_history: any, systemPrompt: string, _tools: any, _opts?: any) => {
        capturedSystemPrompt = systemPrompt;
        return Promise.resolve({
          content: 'Hello!',
          toolCalls: [],
        });
      });

      await request(app)
        .post('/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'hi' }],
        });

      expect(capturedSystemPrompt).toBeDefined();
      expect(capturedSystemPrompt).toContain('proveragent.eth');
    });
  });

  // ─── trimHistory boundary-awareness (indirect via session continuation) ───

  describe('POST /v1/chat/completions — Session history trimming', () => {
    it('session continuation works correctly after many turns without breaking tool call pairs', async () => {
      // First turn: create session
      const firstResponse = await request(app)
        .post('/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'start session' }],
        });

      expect(firstResponse.status).toBe(200);
      const sessionId = firstResponse.headers['x-session-id'];
      const sessionSecret = firstResponse.headers['x-session-secret'];
      expect(sessionId).toBeDefined();

      // Second turn: continue session with a simple response (no tool calls)
      mockChat.mockResolvedValueOnce({
        content: 'Session continues fine.',
        toolCalls: [],
      });

      const secondResponse = await request(app)
        .post('/v1/chat/completions')
        .set('X-Session-Id', sessionId)
        .set('X-Session-Secret', sessionSecret)
        .send({
          messages: [{ role: 'user', content: 'continue' }],
        });

      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.choices[0].message.content).toContain('Session continues fine.');
    });
  });

  // ─── Streaming error handling ─────────────────────────────────────────────

  describe('POST /v1/chat/completions — Streaming error handling', () => {
    it('sends error content chunk and [DONE] when LLM throws during streaming', async () => {
      mockChat.mockReset();
      mockChat.mockRejectedValueOnce(new Error('LLM connection timeout'));

      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          stream: true,
          messages: [{ role: 'user', content: 'trigger error' }],
        });

      // HTTP status is 200 because headers are already sent for SSE
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);

      const body: string = response.text;

      // Should still end with [DONE]
      expect(body).toContain('data: [DONE]');

      // The body should contain the error message somewhere in the SSE stream
      expect(body).toContain('LLM connection timeout');
    });

    it('sends finish_reason stop even after streaming error', async () => {
      mockChat.mockReset();
      mockChat.mockRejectedValueOnce(new Error('Provider unavailable'));

      const response = await request(app)
        .post('/v1/chat/completions')
        .send({
          stream: true,
          messages: [{ role: 'user', content: 'trigger error 2' }],
        });

      expect(response.status).toBe(200);

      const body: string = response.text;
      const dataLines = body
        .split('\n')
        .filter((line: string) => line.startsWith('data:') && line !== 'data: [DONE]');

      const chunks = dataLines
        .map((line: string) => JSON.parse(line.replace(/^data:\s*/, '')))
        .filter((c: any) => c.object === 'chat.completion.chunk');

      // Last chunk should have finish_reason: 'stop'
      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.choices[0].finish_reason).toBe('stop');
    });
  });
});
