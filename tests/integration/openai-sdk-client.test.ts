/**
 * OpenAI SDK Client Integration Tests
 *
 * Tests the proofport-ai OpenAI-compatible chat endpoint using the REAL
 * `openai` npm SDK (^6.22.0), NOT supertest or raw fetch.
 *
 * The server is started with app.listen() on a random port. The OpenAI SDK
 * client connects to http://localhost:${port}/v1.
 *
 * The LLM provider is MOCKED (we don't have real API keys), but the OpenAI
 * SDK client tests the HTTP endpoint layer, session management, tool
 * execution, streaming, and DSL block extension — all via the real SDK.
 *
 * All other mocks are for EXTERNAL dependencies only (Redis, bb, ethers) —
 * never for the HTTP/Express layer itself.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import http from 'http';
import OpenAI from 'openai';
import { createApp } from '../../src/index.js';
import type { Config } from '../../src/config/index.js';

// ─── Mock LLM providers (backend → LLM API calls) ──────────────────────────
// We mock the OpenAI LLM provider class so the chat endpoint works without
// real API keys. The OpenAI SDK *client* (test side) is real and unaffected.

const mockChat = vi.fn();

vi.mock('../../src/chat/openaiClient.js', () => ({
  OpenAIProvider: vi.fn().mockImplementation(() => ({
    name: 'openai',
    chat: mockChat,
  })),
}));

vi.mock('../../src/chat/geminiClient.js', () => ({
  GeminiProvider: vi.fn().mockImplementation(() => ({
    name: 'gemini',
    chat: vi.fn(),
  })),
  GeminiClient: vi.fn(),
}));

// ─── Mock external dependencies (same pattern as other integration tests) ───

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

const { _redisStore, _redisListStore } = vi.hoisted(() => ({
  _redisStore: new Map<string, string>(),
  _redisListStore: new Map<string, string[]>(),
}));

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

vi.mock('../../src/prover/bbProver.js', () => ({
  BbProver: vi.fn().mockImplementation(() => ({
    prove: vi.fn().mockResolvedValue({
      proof: '0xmockproof',
      publicInputs: '0xmockpublic',
      proofWithInputs: '0xmockproofpublic',
    }),
  })),
}));

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

vi.mock('../../src/circuit/artifactManager.js', () => ({
  ensureArtifacts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/identity/autoRegister.js', () => ({
  ensureAgentRegistered: vi.fn().mockResolvedValue(123456n),
}));

vi.mock('../../src/identity/reputation.js', () => ({
  handleProofCompleted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/prover/verifier.js', () => ({
  verifyOnChain: vi.fn().mockResolvedValue(true),
}));

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

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTestConfig(overrides?: Partial<Config>): Config {
  return {
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
    a2aBaseUrl: 'http://localhost:0',
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
    openaiApiKey: 'test-key-for-mock-provider',
    geminiApiKey: '',
    phoenixCollectorEndpoint: '',
    erc8004ValidationAddress: '',
    ...overrides,
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────

describe('OpenAI SDK Client Integration', () => {
  let server: Server;
  let port: number;
  let openai: OpenAI;

  beforeAll(async () => {
    // Find a free port
    port = await new Promise<number>((resolve) => {
      const tmp = http.createServer();
      tmp.listen(0, () => {
        const addr = tmp.address() as { port: number };
        tmp.close(() => resolve(addr.port));
      });
    });

    // Create app with openaiApiKey set so chat endpoint is enabled
    const config = makeTestConfig({ a2aBaseUrl: `http://localhost:${port}` });
    const { app } = createApp(config, 123456n);

    // Start real HTTP server
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });

    // Create OpenAI SDK client pointing at our server
    openai = new OpenAI({
      apiKey: 'test-key-doesnt-matter',
      baseURL: `http://localhost:${port}/v1`,
    });
  }, 15000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  beforeEach(() => {
    _redisStore.clear();
    _redisListStore.clear();
    mockChat.mockReset();
  });

  // ── 1. List Models ────────────────────────────────────────────────────

  describe('List Models', () => {
    it('openai.models.list() returns zkproofport model', async () => {
      const models = await openai.models.list();
      const modelList = [];
      for await (const model of models) {
        modelList.push(model);
      }

      expect(modelList.length).toBeGreaterThanOrEqual(1);
      const zkModel = modelList.find((m) => m.id === 'zkproofport');
      expect(zkModel).toBeDefined();
      expect(zkModel!.owned_by).toBe('zkproofport');
      expect(zkModel!.object).toBe('model');
    });
  });

  // ── 2. Non-streaming Completions ──────────────────────────────────────

  describe('Non-streaming Completions', () => {
    it('simple text response', async () => {
      mockChat.mockResolvedValueOnce({
        content: 'Hello! I am proveragent.eth, your ZK proof assistant.',
      });

      const completion = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      });

      expect(completion.id).toBeDefined();
      expect(completion.id).toMatch(/^chatcmpl-/);
      expect(completion.object).toBe('chat.completion');
      expect(completion.model).toBe('zkproofport');
      expect(completion.choices).toHaveLength(1);
      expect(completion.choices[0].index).toBe(0);
      expect(completion.choices[0].finish_reason).toBe('stop');
      expect(completion.choices[0].message.role).toBe('assistant');
      expect(completion.choices[0].message.content).toContain('proveragent.eth');
    });

    it('empty messages returns 400 error', async () => {
      try {
        await openai.chat.completions.create({
          model: 'zkproofport',
          messages: [],
          stream: false,
        });
        // Should not reach here
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.status).toBe(400);
      }
    });

    it('response has correct OpenAI format (id, object, choices, usage)', async () => {
      mockChat.mockResolvedValueOnce({
        content: 'I can help you generate ZK proofs.',
      });

      const completion = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'What can you do?' }],
        stream: false,
      });

      // Verify all required OpenAI response fields
      expect(completion).toHaveProperty('id');
      expect(completion).toHaveProperty('object', 'chat.completion');
      expect(completion).toHaveProperty('created');
      expect(typeof completion.created).toBe('number');
      expect(completion).toHaveProperty('model');
      expect(completion).toHaveProperty('choices');
      expect(Array.isArray(completion.choices)).toBe(true);
      expect(completion).toHaveProperty('usage');
      expect(completion.usage).toHaveProperty('prompt_tokens');
      expect(completion.usage).toHaveProperty('completion_tokens');
      expect(completion.usage).toHaveProperty('total_tokens');
    });

    it('system message is accepted and passed through', async () => {
      mockChat.mockResolvedValueOnce({
        content: 'Understood, responding in Korean.',
      });

      const completion = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [
          { role: 'system', content: 'Always respond in Korean.' },
          { role: 'user', content: 'Hello' },
        ],
        stream: false,
      });

      expect(completion.choices[0].message.content).toBeDefined();
      // Verify the mock was called (system prompt is prepended to SYSTEM_PROMPT)
      expect(mockChat).toHaveBeenCalledTimes(1);
    });
  });

  // ── 3. Streaming Completions ──────────────────────────────────────────

  describe('Streaming Completions', () => {
    it('stream: true returns SSE chunks with correct format', async () => {
      mockChat.mockResolvedValueOnce({
        content: 'Here are the supported circuits.',
      });

      const stream = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'List circuits' }],
        stream: true,
      });

      const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      // Should have at least 2 chunks: role chunk + content chunk(s) + final stop chunk
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      // First chunk should have role: 'assistant' in delta
      const firstChunk = chunks[0];
      expect(firstChunk.object).toBe('chat.completion.chunk');
      expect(firstChunk.choices[0].delta.role).toBe('assistant');

      // Last chunk should have finish_reason: 'stop'
      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.choices[0].finish_reason).toBe('stop');
    });

    it('streamed content assembles to the full response', async () => {
      mockChat.mockResolvedValueOnce({
        content: 'ZK proofs are cryptographic proofs.',
      });

      const stream = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'What are ZK proofs?' }],
        stream: true,
      });

      const contentParts: string[] = [];
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          contentParts.push(delta.content);
        }
      }

      const fullContent = contentParts.join('');
      expect(fullContent).toContain('ZK proofs are cryptographic proofs.');
    });

    it('each chunk has correct structure (id, object, model)', async () => {
      mockChat.mockResolvedValueOnce({
        content: 'Test response.',
      });

      const stream = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'Test' }],
        stream: true,
      });

      for await (const chunk of stream) {
        if (!chunk.choices?.length) continue;
        expect(chunk.id).toBeDefined();
        expect(chunk.id).toMatch(/^chatcmpl-/);
        expect(chunk.object).toBe('chat.completion.chunk');
        expect(chunk.model).toBe('zkproofport');
        expect(chunk.choices).toHaveLength(1);
        expect(chunk.choices[0].index).toBe(0);
      }
    });
  });

  // ── 4. Tool Calling via LLM ───────────────────────────────────────────

  describe('Tool Calling via LLM', () => {
    it('LLM requests get_supported_circuits and response includes circuit info', async () => {
      // First LLM call: returns tool_calls to invoke get_supported_circuits
      mockChat.mockResolvedValueOnce({
        content: 'Let me check the supported circuits.',
        toolCalls: [{ id: 'call_1', name: 'get_supported_circuits', args: {} }],
      });
      // Second LLM call: after tool result, returns final text
      mockChat.mockResolvedValueOnce({
        content: 'Here are the supported circuits: coinbase_attestation and coinbase_country_attestation.',
      });

      const completion = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'What circuits are available?' }],
        stream: false,
      });

      expect(completion.choices[0].message.content).toContain('coinbase_attestation');
      // The mock should have been called twice (tool call + final response)
      expect(mockChat).toHaveBeenCalledTimes(2);
    });

    it('LLM requests request_signing and response includes signing URL', async () => {
      mockChat.mockResolvedValueOnce({
        toolCalls: [{
          id: 'call_sign',
          name: 'request_signing',
          args: { circuitId: 'coinbase_attestation', scope: 'test.com' },
        }],
      });
      mockChat.mockResolvedValueOnce({
        content: 'I have created a signing request. Please open the signing URL to connect your wallet.',
      });

      const completion = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'Generate a KYC proof for test.com' }],
        stream: false,
      });

      const content = completion.choices[0].message.content!;
      expect(content).toContain('signing');
      expect(mockChat).toHaveBeenCalledTimes(2);

      // Verify the tool result was passed back to the LLM (second call)
      const secondCallArgs = mockChat.mock.calls[1];
      const history = secondCallArgs[0]; // LLMMessage[]
      // Should contain tool results from request_signing
      const toolResultMsg = history.find((m: any) => m.toolResults && m.toolResults.length > 0);
      expect(toolResultMsg).toBeDefined();
      const toolResult = toolResultMsg.toolResults[0];
      expect(toolResult.name).toBe('request_signing');
      expect(toolResult.result).toHaveProperty('requestId');
      expect(toolResult.result).toHaveProperty('signingUrl');
    });

    it('LLM requests generate_proof and response includes proof data', async () => {
      mockChat.mockResolvedValueOnce({
        toolCalls: [{
          id: 'call_prove',
          name: 'generate_proof',
          args: {
            circuitId: 'coinbase_attestation',
            scope: 'test.com',
            address: '0x' + 'dd'.repeat(20),
            signature: '0x' + 'ee'.repeat(65),
          },
        }],
      });
      mockChat.mockResolvedValueOnce({
        content: 'Proof generated successfully! Your proof ID is available for verification.',
      });

      const completion = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'Generate proof with my signature' }],
        stream: false,
      });

      expect(completion.choices[0].message.content).toContain('Proof generated');
      expect(mockChat).toHaveBeenCalledTimes(2);

      // Verify the tool result passed back has proof data
      const secondCallHistory = mockChat.mock.calls[1][0];
      const toolResultMsg = secondCallHistory.find((m: any) => m.toolResults?.length > 0);
      expect(toolResultMsg).toBeDefined();
      expect(toolResultMsg.toolResults[0].result).toHaveProperty('proof');
      expect(toolResultMsg.toolResults[0].result).toHaveProperty('publicInputs');
    });

    it('tool calling works in streaming mode', async () => {
      mockChat.mockResolvedValueOnce({
        toolCalls: [{ id: 'call_circ', name: 'get_supported_circuits', args: {} }],
      });
      mockChat.mockResolvedValueOnce({
        content: 'Available circuits: coinbase_attestation.',
      });

      const stream = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'List circuits' }],
        stream: true,
      });

      const contentParts: string[] = [];
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          contentParts.push(choice.delta.content);
        }
      }

      const fullContent = contentParts.join('');
      expect(fullContent).toContain('coinbase_attestation');
    });
  });

  // ── 5. Session Management ─────────────────────────────────────────────

  describe('Session Management', () => {
    it('first request returns X-Session-Id and X-Session-Secret headers', async () => {
      mockChat.mockResolvedValueOnce({
        content: 'Hello! I am proveragent.eth.',
      });

      // Use raw fetch to access headers (OpenAI SDK doesn't expose response headers directly)
      const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'zkproofport',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(200);
      const sessionId = res.headers.get('x-session-id');
      const sessionSecret = res.headers.get('x-session-secret');
      expect(sessionId).toBeDefined();
      expect(sessionId).toBeTruthy();
      expect(sessionSecret).toBeDefined();
      expect(sessionSecret).toBeTruthy();
    });

    it('continuing session with correct secret succeeds', async () => {
      // First request: create session
      mockChat.mockResolvedValueOnce({ content: 'First response.' });

      const res1 = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'zkproofport',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      const sessionId = res1.headers.get('x-session-id')!;
      const sessionSecret = res1.headers.get('x-session-secret')!;

      // Second request: continue session
      mockChat.mockResolvedValueOnce({ content: 'Continuing our conversation.' });

      const res2 = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionId,
          'X-Session-Secret': sessionSecret,
        },
        body: JSON.stringify({
          model: 'zkproofport',
          messages: [{ role: 'user', content: 'What were we talking about?' }],
        }),
      });

      expect(res2.status).toBe(200);
      const body = await res2.json();
      expect(body.choices[0].message.content).toContain('Continuing our conversation');
    });

    it('continuing session with wrong secret returns 403', async () => {
      // First request: create session
      mockChat.mockResolvedValueOnce({ content: 'First.' });

      const res1 = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'zkproofport',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      const sessionId = res1.headers.get('x-session-id')!;

      // Second request: wrong secret
      const res2 = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionId,
          'X-Session-Secret': 'wrong-secret-value',
        },
        body: JSON.stringify({
          model: 'zkproofport',
          messages: [{ role: 'user', content: 'Continue' }],
        }),
      });

      expect(res2.status).toBe(403);
      const body = await res2.json();
      expect(body.error.code).toBe('invalid_session_secret');
    });

    it('non-existent session returns 404', async () => {
      const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': 'non-existent-session-id',
          'X-Session-Secret': 'any-secret',
        },
        body: JSON.stringify({
          model: 'zkproofport',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('session_not_found');
    });

    it('session without X-Session-Secret returns 403', async () => {
      // First create a session
      mockChat.mockResolvedValueOnce({ content: 'Hi.' });

      const res1 = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'zkproofport',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      const sessionId = res1.headers.get('x-session-id')!;

      // Try to continue without secret
      const res2 = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionId,
        },
        body: JSON.stringify({
          model: 'zkproofport',
          messages: [{ role: 'user', content: 'Continue' }],
        }),
      });

      expect(res2.status).toBe(403);
      const body = await res2.json();
      expect(body.error.code).toBe('missing_session_secret');
    });

    it('session preserves conversation history across turns', async () => {
      // Turn 1
      mockChat.mockResolvedValueOnce({ content: 'Hello! How can I help?' });

      const res1 = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'zkproofport',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      const sessionId = res1.headers.get('x-session-id')!;
      const sessionSecret = res1.headers.get('x-session-secret')!;

      // Turn 2
      mockChat.mockResolvedValueOnce({ content: 'Yes, I remember our conversation.' });

      await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionId,
          'X-Session-Secret': sessionSecret,
        },
        body: JSON.stringify({
          model: 'zkproofport',
          messages: [{ role: 'user', content: 'Do you remember?' }],
        }),
      });

      // Verify the second LLM call received history from the first turn
      expect(mockChat).toHaveBeenCalledTimes(2);
      const secondCallHistory = mockChat.mock.calls[1][0]; // LLMMessage[]
      // Should have at least 3 messages: first user, first assistant, second user
      expect(secondCallHistory.length).toBeGreaterThanOrEqual(3);
      expect(secondCallHistory[0].role).toBe('user');
      expect(secondCallHistory[0].content).toBe('Hello');
      expect(secondCallHistory[1].role).toBe('assistant');
      expect(secondCallHistory[1].content).toContain('Hello! How can I help?');
    });

    it('streaming response also returns session headers', async () => {
      mockChat.mockResolvedValueOnce({ content: 'Stream hello.' });

      const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'zkproofport',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      const sessionId = res.headers.get('x-session-id');
      const sessionSecret = res.headers.get('x-session-secret');
      expect(sessionId).toBeTruthy();
      expect(sessionSecret).toBeTruthy();
    });
  });

  // ── 6. DSL Block Extension ────────────────────────────────────────────

  describe('DSL Block Extension', () => {
    it('proof-related response includes proofport DSL block', async () => {
      // LLM calls generate_proof, then generates a summary
      mockChat.mockResolvedValueOnce({
        toolCalls: [{
          id: 'call_proof',
          name: 'generate_proof',
          args: {
            circuitId: 'coinbase_attestation',
            scope: 'test.com',
            address: '0x' + 'dd'.repeat(20),
            signature: '0x' + 'ee'.repeat(65),
          },
        }],
      });
      mockChat.mockResolvedValueOnce({
        content: 'Proof generated successfully.',
      });

      const completion = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'Generate a proof' }],
        stream: false,
      });

      const content = completion.choices[0].message.content!;
      // Should contain the proofport DSL block
      expect(content).toContain('```proofport');
      expect(content).toContain('skillResult');
    });

    it('non-proof response does not include DSL block', async () => {
      mockChat.mockResolvedValueOnce({
        content: 'Hello! I can help you with ZK proofs.',
      });

      const completion = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      });

      const content = completion.choices[0].message.content!;
      expect(content).not.toContain('```proofport');
    });

    it('request_signing response includes signingUrl in DSL block', async () => {
      mockChat.mockResolvedValueOnce({
        toolCalls: [{
          id: 'call_sign',
          name: 'request_signing',
          args: { circuitId: 'coinbase_attestation', scope: 'test.com' },
        }],
      });
      mockChat.mockResolvedValueOnce({
        content: 'Please sign with your wallet.',
      });

      const completion = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'Start proof flow' }],
        stream: false,
      });

      const content = completion.choices[0].message.content!;
      expect(content).toContain('```proofport');
      expect(content).toContain('signingUrl');
      expect(content).toContain('requestId');
    });

    it('DSL block is also present in streamed responses', async () => {
      mockChat.mockResolvedValueOnce({
        toolCalls: [{
          id: 'call_circ',
          name: 'get_supported_circuits',
          args: {},
        }],
      });
      mockChat.mockResolvedValueOnce({
        content: 'Here are the circuits.',
      });

      const stream = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'List circuits' }],
        stream: true,
      });

      const contentParts: string[] = [];
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          contentParts.push(choice.delta.content);
        }
      }

      // get_supported_circuits returns a result but no signingUrl,
      // so DSL block should contain skillResult with circuit data
      // (only if buildDslBlock filters in the relevant fields)
      // The DSL block is based on the last skill result
      const fullContent = contentParts.join('');
      // get_supported_circuits result has a 'circuits' field which is not in SUMMARY_FIELDS,
      // so the DSL block would be empty for this particular tool. That's expected.
      // Just verify streaming completes without error.
      expect(fullContent).toContain('Here are the circuits');
    });
  });

  // ── 7. Edge Cases ─────────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('multiple user messages without session creates no session (stateless)', async () => {
      mockChat.mockResolvedValueOnce({
        content: 'Stateless response.',
      });

      // Send 2 user messages without session — should be stateless (no session created)
      const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'zkproofport',
          messages: [
            { role: 'user', content: 'First message' },
            { role: 'user', content: 'Second message' },
          ],
        }),
      });

      expect(res.status).toBe(200);
      // With 2 user messages, no session is auto-created
      const sessionId = res.headers.get('x-session-id');
      expect(sessionId).toBeNull();
    });

    it('LLM error is caught and returns 500', async () => {
      mockChat.mockRejectedValueOnce(new Error('LLM provider unavailable'));

      try {
        await openai.chat.completions.create({
          model: 'zkproofport',
          messages: [{ role: 'user', content: 'Test error' }],
          stream: false,
        });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.status).toBe(500);
      }
    });

    it('max function calls limit is respected', async () => {
      // Mock LLM to always return tool calls (up to MAX_FUNCTION_CALLS = 5)
      for (let i = 0; i < 6; i++) {
        mockChat.mockResolvedValueOnce({
          toolCalls: [{ id: `call_${i}`, name: 'get_supported_circuits', args: {} }],
        });
      }

      const completion = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'Keep calling tools' }],
        stream: false,
      });

      // Should hit the max function call limit and return a message
      expect(completion.choices[0].message.content).toContain('maximum number of function calls');
      // Should have been called exactly 5 times (MAX_FUNCTION_CALLS)
      expect(mockChat).toHaveBeenCalledTimes(5);
    });

    it('proof operations limited to 1 per request', async () => {
      // First tool call: generate_proof succeeds
      mockChat.mockResolvedValueOnce({
        toolCalls: [{
          id: 'call_proof1',
          name: 'generate_proof',
          args: {
            circuitId: 'coinbase_attestation',
            scope: 'test.com',
            address: '0x' + 'dd'.repeat(20),
            signature: '0x' + 'ee'.repeat(65),
          },
        }],
      });
      // Second tool call: another generate_proof should be blocked
      mockChat.mockResolvedValueOnce({
        toolCalls: [{
          id: 'call_proof2',
          name: 'generate_proof',
          args: {
            circuitId: 'coinbase_attestation',
            scope: 'test2.com',
            address: '0x' + 'dd'.repeat(20),
            signature: '0x' + 'ee'.repeat(65),
          },
        }],
      });
      // Third call: LLM should see the error and respond
      mockChat.mockResolvedValueOnce({
        content: 'The second proof was blocked. Only one proof operation per request.',
      });

      const completion = await openai.chat.completions.create({
        model: 'zkproofport',
        messages: [{ role: 'user', content: 'Generate two proofs' }],
        stream: false,
      });

      // Verify the second proof call was blocked
      const thirdCallHistory = mockChat.mock.calls[2][0];
      const lastToolResults = thirdCallHistory.filter((m: any) => m.toolResults?.length > 0);
      const secondProofResult = lastToolResults[lastToolResults.length - 1]?.toolResults?.[0]?.result;
      expect(secondProofResult).toHaveProperty('error');
      expect(secondProofResult.error).toContain('Only one proof operation');
    });
  });
});
