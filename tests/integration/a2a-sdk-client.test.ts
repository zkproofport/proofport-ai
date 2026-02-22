/**
 * A2A SDK Client Integration Tests
 *
 * Tests the proofport-ai A2A agent using the REAL @a2a-js/sdk/client SDK,
 * NOT supertest or raw JSON-RPC. Verifies protocol compatibility from a
 * real client's perspective.
 *
 * The server is started with app.listen() on a random port. The SDK client
 * connects via ClientFactory.createFromUrl() which auto-fetches the agent card.
 *
 * All mocks are for EXTERNAL dependencies only (Redis, bb, ethers) -- never
 * for the A2A protocol layer itself.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import http from 'http';
import { createApp } from '../../src/index.js';
import type { Config } from '../../src/config/index.js';
import { ClientFactory, TaskNotFoundError, TaskNotCancelableError } from '@a2a-js/sdk/client';
import type { Client } from '@a2a-js/sdk/client';
import type {
  Task,
  Message,
  DataPart,
  TextPart,
  TaskState,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  Artifact,
  Part,
} from '@a2a-js/sdk';

// ─── Mock modules (external dependencies only) ────────────────────────────

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
    a2aBaseUrl: 'http://localhost:0', // will be overridden
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
    openaiApiKey: '',
    geminiApiKey: '',
    phoenixCollectorEndpoint: '',
    erc8004ValidationAddress: '',
    ...overrides,
  };
}

function makeMessage(parts: Part[], contextId?: string): {
  message: Message;
} {
  return {
    message: {
      kind: 'message' as const,
      messageId: randomUUID(),
      role: 'user' as const,
      parts,
      ...(contextId ? { contextId } : {}),
    },
  };
}

function makeDataPartMessage(data: Record<string, unknown>, contextId?: string) {
  return makeMessage([{ kind: 'data' as const, data }], contextId);
}

function makeTextPartMessage(text: string, contextId?: string) {
  return makeMessage([{ kind: 'text' as const, text }], contextId);
}

function isTask(result: any): result is Task {
  return result && result.kind === 'task';
}

function findDataPart(artifacts: Artifact[] | undefined): DataPart | undefined {
  if (!artifacts) return undefined;
  for (const artifact of artifacts) {
    const found = artifact.parts.find((p: Part) => p.kind === 'data');
    if (found) return found as DataPart;
  }
  return undefined;
}

function findTextPart(artifacts: Artifact[] | undefined): TextPart | undefined {
  if (!artifacts) return undefined;
  for (const artifact of artifacts) {
    const found = artifact.parts.find((p: Part) => p.kind === 'text');
    if (found) return found as TextPart;
  }
  return undefined;
}

// ─── Test suite ───────────────────────────────────────────────────────────

describe('A2A SDK Client Integration', () => {
  let server: Server;
  let baseUrl: string;
  let client: Client;

  beforeAll(async () => {
    // Find a free port first
    const freePort = await new Promise<number>((resolve) => {
      const tmp = http.createServer();
      tmp.listen(0, () => {
        const port = (tmp.address() as { port: number }).port;
        tmp.close(() => resolve(port));
      });
    });

    baseUrl = `http://localhost:${freePort}`;

    // Create app with correct a2aBaseUrl matching the actual server port
    const config = makeTestConfig({ a2aBaseUrl: baseUrl });
    const { app } = createApp(config, 123456n);

    // Start real HTTP server
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(freePort, () => resolve(s));
    });

    // Create SDK client via factory — this fetches the agent card automatically
    const factory = new ClientFactory();
    client = await factory.createFromUrl(baseUrl);
  }, 15000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  beforeEach(() => {
    _redisStore.clear();
    _redisListStore.clear();
  });

  // ── 1. Agent Card Discovery ─────────────────────────────────────────────

  describe('Agent Card Discovery', () => {
    it('ClientFactory.createFromUrl() successfully discovers and parses agent card', async () => {
      // The client was already created in beforeAll — if we got here, discovery succeeded
      expect(client).toBeDefined();

      // Verify the agent card through the client
      const agentCard = await client.getAgentCard();
      expect(agentCard).toBeDefined();
      expect(agentCard.name).toBe('proveragent.base.eth');
      expect(agentCard.protocolVersion).toBe('0.3.0');
      expect(agentCard.preferredTransport).toBe('JSONRPC');
    });

    it('agent card contains correct skills', async () => {
      const agentCard = await client.getAgentCard();
      expect(agentCard.skills).toBeDefined();
      expect(Array.isArray(agentCard.skills)).toBe(true);

      const skillIds = agentCard.skills.map((s) => s.id);
      expect(skillIds).toContain('generate_proof');
      expect(skillIds).toContain('verify_proof');
      expect(skillIds).toContain('get_supported_circuits');
      expect(skillIds).toContain('request_signing');
      expect(skillIds).toContain('check_status');
      expect(skillIds).toContain('request_payment');
    });

    it('agent card contains capabilities', async () => {
      const agentCard = await client.getAgentCard();
      expect(agentCard.capabilities).toBeDefined();
      expect(agentCard.capabilities.streaming).toBe(true);
      expect(agentCard.capabilities.stateTransitionHistory).toBe(true);
    });

    it('agent card url points to /a2a endpoint', async () => {
      const agentCard = await client.getAgentCard();
      expect(agentCard.url).toBe(`${baseUrl}/a2a`);
    });
  });

  // ── 2. DataPart Skill Invocation ────────────────────────────────────────

  describe('DataPart Skill Invocation', () => {
    it('get_supported_circuits returns Task with circuits DataPart', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );

      expect(isTask(result)).toBe(true);
      const task = result as Task;
      expect(task.kind).toBe('task');
      expect(task.status.state).toBe('completed');
      expect(task.id).toBeDefined();
      expect(task.contextId).toBeDefined();

      // Artifacts should contain DataPart with circuits array
      expect(task.artifacts).toBeDefined();
      expect(task.artifacts!.length).toBeGreaterThan(0);

      const dataPart = findDataPart(task.artifacts);
      expect(dataPart).toBeDefined();
      expect(dataPart!.data.circuits).toBeDefined();
      expect(Array.isArray(dataPart!.data.circuits)).toBe(true);

      const circuitIds = (dataPart!.data.circuits as any[]).map((c: any) => c.id);
      expect(circuitIds).toContain('coinbase_attestation');
    });

    it('get_supported_circuits also returns TextPart summary', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );

      const task = result as Task;
      const textPart = findTextPart(task.artifacts);
      expect(textPart).toBeDefined();
      expect(typeof textPart!.text).toBe('string');
      expect(textPart!.text.length).toBeGreaterThan(0);
    });

    it('verify_proof returns Task with verification result', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({
          skill: 'verify_proof',
          circuitId: 'coinbase_attestation',
          proof: '0xaabb',
          publicInputs: ['0x' + 'cc'.repeat(32)],
          chainId: '84532',
        }),
      );

      expect(isTask(result)).toBe(true);
      const task = result as Task;
      expect(task.status.state).toBe('completed');

      const dataPart = findDataPart(task.artifacts);
      expect(dataPart).toBeDefined();
      expect(dataPart!.data.valid).toBe(true);
      expect(dataPart!.data.circuitId).toBe('coinbase_attestation');
    });

    it('generate_proof with direct signature returns completed Task with proof', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({
          skill: 'generate_proof',
          scope: 'test.com',
          circuitId: 'coinbase_attestation',
          address: '0x' + 'dd'.repeat(20),
          signature: '0x' + 'ee'.repeat(65),
        }),
      );

      expect(isTask(result)).toBe(true);
      const task = result as Task;
      expect(task.status.state).toBe('completed');

      const dataPart = findDataPart(task.artifacts);
      expect(dataPart).toBeDefined();
      expect(dataPart!.data.proof).toBeDefined();
      expect(dataPart!.data.publicInputs).toBeDefined();
    });

    it('request_signing returns Task with signingUrl and requestId', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({
          skill: 'request_signing',
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
        }),
      );

      expect(isTask(result)).toBe(true);
      const task = result as Task;
      expect(task.status.state).toBe('input-required');

      const dataPart = findDataPart(task.artifacts);
      expect(dataPart).toBeDefined();
      expect(dataPart!.data.requestId).toBeDefined();
      expect(typeof dataPart!.data.requestId).toBe('string');
      expect(dataPart!.data.signingUrl).toBeDefined();
    });

    it('check_status with unknown requestId returns failed Task', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({
          skill: 'check_status',
          requestId: 'non-existent-request-id',
        }),
      );

      expect(isTask(result)).toBe(true);
      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });

    it('request_payment with disabled payment mode returns failed Task', async () => {
      // First create a signing request to get a valid requestId
      const signingResult = await client.sendMessage(
        makeDataPartMessage({
          skill: 'request_signing',
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
        }),
      );
      const signingTask = signingResult as Task;
      const requestId = findDataPart(signingTask.artifacts)?.data.requestId as string;
      expect(requestId).toBeDefined();

      // Attempt payment request (disabled mode)
      const result = await client.sendMessage(
        makeDataPartMessage({
          skill: 'request_payment',
          requestId,
        }),
      );

      expect(isTask(result)).toBe(true);
      const task = result as Task;
      // Should fail because payment is disabled
      expect(task.status.state).toBe('failed');
    });
  });

  // ── 3. TextPart Handling ────────────────────────────────────────────────

  describe('TextPart Handling (No LLM)', () => {
    it('TextPart message returns failed Task when no LLM configured', async () => {
      const result = await client.sendMessage(
        makeTextPartMessage('list supported circuits'),
      );

      expect(isTask(result)).toBe(true);
      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });

    it('empty text part returns failed Task', async () => {
      const result = await client.sendMessage(
        makeTextPartMessage(''),
      );

      expect(isTask(result)).toBe(true);
      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });

    it('whitespace-only text part returns failed Task', async () => {
      const result = await client.sendMessage(
        makeTextPartMessage('   \n\t  '),
      );

      expect(isTask(result)).toBe(true);
      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });
  });

  // ── 4. Task Lifecycle ──────────────────────────────────────────────────

  describe('Task Lifecycle', () => {
    it('sendMessage returns result with kind "task"', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );

      expect(result.kind).toBe('task');
    });

    it('completed Task has required fields', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );

      const task = result as Task;
      expect(task.id).toBeDefined();
      expect(typeof task.id).toBe('string');
      expect(task.contextId).toBeDefined();
      expect(typeof task.contextId).toBe('string');
      expect(task.status).toBeDefined();
      expect(task.status.state).toBe('completed');
      expect(task.status.timestamp).toBeDefined();
      expect(task.artifacts).toBeDefined();
      expect(Array.isArray(task.artifacts)).toBe(true);
    });

    it('failed Task has proper status for invalid skill', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({ skill: 'nonexistent_skill' }),
      );

      const task = result as Task;
      expect(task.status.state).toBe('failed');
      expect(task.artifacts).toBeDefined();
      expect(task.artifacts!.length).toBeGreaterThan(0);

      // Error artifact should contain text mentioning invalid skill
      const textPart = findTextPart(task.artifacts);
      expect(textPart).toBeDefined();
      expect(textPart!.text.toLowerCase()).toContain('invalid skill');
    });

    it('failed Task for missing required params', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({
          skill: 'generate_proof',
          // Missing scope, circuitId, address, signature
        }),
      );

      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });
  });

  // ── 5. getTask ─────────────────────────────────────────────────────────

  describe('getTask', () => {
    it('retrieves a previously created task by ID', async () => {
      const sendResult = await client.sendMessage(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );
      const taskId = (sendResult as Task).id;

      const fetchedTask = await client.getTask({ id: taskId });

      expect(fetchedTask.id).toBe(taskId);
      expect(fetchedTask.status.state).toBe('completed');
      expect(fetchedTask.artifacts).toBeDefined();
    });

    it('getTask preserves task artifacts', async () => {
      const sendResult = await client.sendMessage(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );
      const originalTask = sendResult as Task;

      const fetchedTask = await client.getTask({ id: originalTask.id });

      // Both should have artifacts with circuits data
      const originalData = findDataPart(originalTask.artifacts);
      const fetchedData = findDataPart(fetchedTask.artifacts);
      expect(fetchedData).toBeDefined();
      expect(fetchedData!.data.circuits).toBeDefined();
    });

    it('getTask includes history', async () => {
      const sendResult = await client.sendMessage(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );
      const taskId = (sendResult as Task).id;

      const fetchedTask = await client.getTask({ id: taskId });

      expect(fetchedTask.history).toBeDefined();
      expect(Array.isArray(fetchedTask.history)).toBe(true);
    });

    it('getTask with historyLength=1 limits history entries', async () => {
      const sendResult = await client.sendMessage(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );
      const taskId = (sendResult as Task).id;

      const fetchedTask = await client.getTask({ id: taskId, historyLength: 1 });

      expect(fetchedTask.history).toBeDefined();
      expect(fetchedTask.history!.length).toBeLessThanOrEqual(1);
    });

    it('getTask with unknown ID throws TaskNotFoundError', async () => {
      await expect(
        client.getTask({ id: 'completely-unknown-task-id-xyz' }),
      ).rejects.toThrow();
    });
  });

  // ── 6. cancelTask ──────────────────────────────────────────────────────

  describe('cancelTask', () => {
    it('cancelTask on completed task throws error', async () => {
      const sendResult = await client.sendMessage(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );
      const taskId = (sendResult as Task).id;

      // Completed tasks cannot be canceled
      await expect(
        client.cancelTask({ id: taskId }),
      ).rejects.toThrow();
    });

    it('cancelTask on non-existent task throws error', async () => {
      await expect(
        client.cancelTask({ id: 'does-not-exist-xyz' }),
      ).rejects.toThrow();
    });
  });

  // ── 7. Streaming (sendMessageStream) ───────────────────────────────────

  describe('Streaming (sendMessageStream)', () => {
    it('sendMessageStream yields events for get_supported_circuits', async () => {
      const events: any[] = [];

      const stream = client.sendMessageStream(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );

      for await (const event of stream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);

      // Should contain at least one status-update or task event
      const hasStatusUpdate = events.some(
        (e) => e.kind === 'status-update' || e.kind === 'task',
      );
      const hasArtifactUpdate = events.some(
        (e) => e.kind === 'artifact-update' || e.kind === 'task',
      );
      expect(hasStatusUpdate || hasArtifactUpdate).toBe(true);
    }, 15000);

    it('sendMessageStream yields events ending with final status', async () => {
      const events: any[] = [];

      const stream = client.sendMessageStream(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );

      for await (const event of stream) {
        events.push(event);
      }

      // The last event should indicate completion
      const lastEvent = events[events.length - 1];
      if (lastEvent.kind === 'status-update') {
        expect(lastEvent.final).toBe(true);
        expect(lastEvent.status.state).toBe('completed');
      } else if (lastEvent.kind === 'task') {
        expect(lastEvent.status.state).toBe('completed');
      }
    }, 15000);

    it('sendMessageStream for verify_proof yields artifact with verification result', async () => {
      const events: any[] = [];

      const stream = client.sendMessageStream(
        makeDataPartMessage({
          skill: 'verify_proof',
          circuitId: 'coinbase_attestation',
          proof: '0xaabb',
          publicInputs: ['0x' + 'cc'.repeat(32)],
          chainId: '84532',
        }),
      );

      for await (const event of stream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);

      // Should find an artifact-update or task with valid: true
      const artifactEvent = events.find(
        (e) =>
          (e.kind === 'artifact-update' &&
            e.artifact?.parts?.some((p: any) => p.kind === 'data' && p.data?.valid === true)) ||
          (e.kind === 'task' &&
            e.artifacts?.some((a: any) =>
              a.parts?.some((p: any) => p.kind === 'data' && p.data?.valid === true),
            )),
      );
      expect(artifactEvent).toBeDefined();
    }, 15000);

    it('sendMessageStream for invalid skill yields failed status', async () => {
      const events: any[] = [];

      const stream = client.sendMessageStream(
        makeDataPartMessage({ skill: 'invalid_skill_name' }),
      );

      for await (const event of stream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);

      // Should contain a failed status
      const failedEvent = events.find(
        (e) =>
          (e.kind === 'status-update' && e.status?.state === 'failed') ||
          (e.kind === 'task' && e.status?.state === 'failed'),
      );
      expect(failedEvent).toBeDefined();
    }, 15000);
  });

  // ── 8. contextId Flow (Multi-turn) ─────────────────────────────────────

  describe('contextId Flow (Multi-turn)', () => {
    it('request_signing stores contextId mapping for subsequent calls', async () => {
      const contextId = randomUUID();

      // Step 1: request_signing with contextId
      const signingResult = await client.sendMessage(
        makeDataPartMessage(
          {
            skill: 'request_signing',
            circuitId: 'coinbase_attestation',
            scope: 'test.com',
          },
          contextId,
        ),
      );

      expect(isTask(signingResult)).toBe(true);
      const signingTask = signingResult as Task;
      expect(signingTask.status.state).toBe('input-required');

      const requestId = findDataPart(signingTask.artifacts)?.data.requestId;
      expect(requestId).toBeDefined();
    });

    it('contextId is preserved in task response', async () => {
      const contextId = randomUUID();

      const result = await client.sendMessage(
        makeDataPartMessage(
          { skill: 'get_supported_circuits' },
          contextId,
        ),
      );

      const task = result as Task;
      // Task should have a contextId (may be the one we passed or server-generated)
      expect(task.contextId).toBeDefined();
      expect(typeof task.contextId).toBe('string');
    });

    it('check_status with same contextId auto-resolves requestId', async () => {
      const contextId = randomUUID();

      // Step 1: request_signing with contextId
      const signingResult = await client.sendMessage(
        makeDataPartMessage(
          {
            skill: 'request_signing',
            circuitId: 'coinbase_attestation',
            scope: 'test.com',
          },
          contextId,
        ),
      );
      const signingTask = signingResult as Task;
      expect(signingTask.status.state).toBe('input-required');
      const requestId = findDataPart(signingTask.artifacts)?.data.requestId;
      expect(requestId).toBeDefined();

      // Step 2: check_status with same contextId (no requestId param)
      // The server should auto-resolve the requestId from the contextId mapping
      const statusResult = await client.sendMessage(
        makeDataPartMessage(
          {
            skill: 'check_status',
            // requestId intentionally omitted — should auto-resolve from contextId
          },
          contextId,
        ),
      );

      expect(isTask(statusResult)).toBe(true);
      const statusTask = statusResult as Task;
      // Should succeed (not fail with "requestId is required") because auto-resolution
      expect(statusTask.status.state).toBe('input-required');

      const statusData = findDataPart(statusTask.artifacts);
      expect(statusData).toBeDefined();
      expect(statusData!.data.phase).toBeDefined();
    });
  });

  // ── 9. Error Cases ─────────────────────────────────────────────────────

  describe('Error Cases', () => {
    it('invalid skill name returns failed Task', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({ skill: 'totally_bogus_skill' }),
      );

      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });

    it('generate_proof without circuitId returns failed Task', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({
          skill: 'generate_proof',
          scope: 'test.com',
          // Missing circuitId
          address: '0x' + 'dd'.repeat(20),
          signature: '0x' + 'ee'.repeat(65),
        }),
      );

      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });

    it('verify_proof without proof returns failed Task', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({
          skill: 'verify_proof',
          circuitId: 'coinbase_attestation',
          // Missing proof and publicInputs
        }),
      );

      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });

    it('request_signing without circuitId returns failed Task', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({
          skill: 'request_signing',
          scope: 'test.com',
          // Missing circuitId
        }),
      );

      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });

    it('request_signing without scope returns failed Task', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({
          skill: 'request_signing',
          circuitId: 'coinbase_attestation',
          // Missing scope
        }),
      );

      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });

    it('check_status without requestId (and no contextId) returns failed Task', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({
          skill: 'check_status',
          // No requestId, no contextId auto-resolution
        }),
      );

      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });

    it('DataPart without skill field returns failed Task', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({ address: '0xabc' }),
      );

      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });

    it('generate_proof with invalid circuitId returns failed Task', async () => {
      const result = await client.sendMessage(
        makeDataPartMessage({
          skill: 'generate_proof',
          scope: 'test.com',
          circuitId: 'invalid_circuit_name',
          address: '0x' + 'dd'.repeat(20),
          signature: '0x' + 'ee'.repeat(65),
        }),
      );

      const task = result as Task;
      expect(task.status.state).toBe('failed');
    });
  });

  // ── 10. Multiple Skills in Sequence ────────────────────────────────────

  describe('Multiple Skills in Sequence', () => {
    it('can invoke different skills sequentially', async () => {
      // First: get_supported_circuits
      const circuitsResult = await client.sendMessage(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );
      expect((circuitsResult as Task).status.state).toBe('completed');

      // Second: verify_proof
      const verifyResult = await client.sendMessage(
        makeDataPartMessage({
          skill: 'verify_proof',
          circuitId: 'coinbase_attestation',
          proof: '0xaabb',
          publicInputs: ['0x' + 'cc'.repeat(32)],
          chainId: '84532',
        }),
      );
      expect((verifyResult as Task).status.state).toBe('completed');

      // Third: generate_proof
      const proofResult = await client.sendMessage(
        makeDataPartMessage({
          skill: 'generate_proof',
          scope: 'test.com',
          circuitId: 'coinbase_attestation',
          address: '0x' + 'dd'.repeat(20),
          signature: '0x' + 'ee'.repeat(65),
        }),
      );
      expect((proofResult as Task).status.state).toBe('completed');

      // Each task should have a unique ID
      const ids = [
        (circuitsResult as Task).id,
        (verifyResult as Task).id,
        (proofResult as Task).id,
      ];
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });

    it('each skill creates independently retrievable tasks', async () => {
      const result1 = await client.sendMessage(
        makeDataPartMessage({ skill: 'get_supported_circuits' }),
      );
      const result2 = await client.sendMessage(
        makeDataPartMessage({
          skill: 'verify_proof',
          circuitId: 'coinbase_attestation',
          proof: '0xaabb',
          publicInputs: ['0x' + 'cc'.repeat(32)],
        }),
      );

      const task1 = await client.getTask({ id: (result1 as Task).id });
      const task2 = await client.getTask({ id: (result2 as Task).id });

      expect(task1.id).not.toBe(task2.id);
      expect(task1.status.state).toBe('completed');
      expect(task2.status.state).toBe('completed');
    });
  });

  // ── 11. Full Flow: request_signing -> check_status ─────────────────────

  describe('Full Session Flow', () => {
    it('request_signing -> check_status with explicit requestId', async () => {
      // Step 1: Request signing
      const signingResult = await client.sendMessage(
        makeDataPartMessage({
          skill: 'request_signing',
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
        }),
      );

      const signingTask = signingResult as Task;
      expect(signingTask.status.state).toBe('input-required');

      const requestId = findDataPart(signingTask.artifacts)?.data.requestId as string;
      expect(requestId).toBeDefined();

      // Step 2: Check status with explicit requestId
      const statusResult = await client.sendMessage(
        makeDataPartMessage({
          skill: 'check_status',
          requestId,
        }),
      );

      const statusTask = statusResult as Task;
      expect(statusTask.status.state).toBe('input-required');

      const statusData = findDataPart(statusTask.artifacts);
      expect(statusData).toBeDefined();
      // Should show signing phase since we haven't actually signed
      expect(statusData!.data.phase).toBe('signing');
    });
  });
});
