import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';
import type { Task, Message } from '@a2a-js/sdk';

// ─── Hoisted mock variables ───────────────────────────────────────────────────

const {
  mockHandleRequestSigning,
  mockHandleCheckStatus,
  mockHandleRequestPayment,
  mockHandleGenerateProof,
  mockHandleVerifyProof,
  mockHandleGetSupportedCircuits,
  mockHandleProofCompleted,
  mockJsonRpcProviderCtor,
  mockWalletCtor,
} = vi.hoisted(() => {
  return {
    mockHandleRequestSigning: vi.fn(),
    mockHandleCheckStatus: vi.fn(),
    mockHandleRequestPayment: vi.fn(),
    mockHandleGenerateProof: vi.fn(),
    mockHandleVerifyProof: vi.fn(),
    mockHandleGetSupportedCircuits: vi.fn(),
    mockHandleProofCompleted: vi.fn().mockResolvedValue(undefined),
    mockJsonRpcProviderCtor: vi.fn().mockImplementation(() => ({})),
    mockWalletCtor: vi.fn().mockImplementation(() => ({ address: '0x1234' })),
  };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/skills/skillHandler.js', () => ({
  handleRequestSigning: mockHandleRequestSigning,
  handleCheckStatus: mockHandleCheckStatus,
  handleRequestPayment: mockHandleRequestPayment,
  handleGenerateProof: mockHandleGenerateProof,
  handleVerifyProof: mockHandleVerifyProof,
  handleGetSupportedCircuits: mockHandleGetSupportedCircuits,
}));

vi.mock('../../src/identity/reputation.js', () => ({
  handleProofCompleted: mockHandleProofCompleted,
}));

vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: mockJsonRpcProviderCtor,
    Wallet: mockWalletCtor,
  },
}));

// OpenTelemetry tracer — no-op spans so span.end() etc. don't throw
vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: vi.fn().mockReturnValue({
      startSpan: vi.fn().mockReturnValue({
        setAttribute: vi.fn(),
        setStatus: vi.fn(),
        end: vi.fn(),
      }),
    }),
  },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

// ─── Import SUT after mocks ───────────────────────────────────────────────────

import { ProofportExecutor } from '../../src/a2a/proofportExecutor.js';
import type { ExecutorDeps } from '../../src/a2a/proofportExecutor.js';
import type { Config } from '../../src/config/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEventBus(): ExecutionEventBus {
  return {
    publish: vi.fn(),
    finished: vi.fn(),
  } as unknown as ExecutionEventBus;
}

function makeTaskStore(overrides: Partial<{
  getContextFlow: () => Promise<string | null>;
  setContextFlow: () => Promise<void>;
}> = {}) {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(undefined),
    setContextFlow: vi.fn().mockResolvedValue(undefined),
    getContextFlow: vi.fn().mockResolvedValue(null),
    redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 4002,
    nodeEnv: 'test',
    proverUrl: '',
    bbPath: 'bb',
    nargoPath: 'nargo',
    circuitsDir: '/app/circuits',
    circuitsRepoUrl: '',
    redisUrl: 'redis://localhost:6379',
    baseRpcUrl: 'https://mainnet.base.org',
    easGraphqlEndpoint: 'https://base.easscan.org/graphql',
    chainRpcUrl: 'https://sepolia.base.org',
    nullifierRegistryAddress: '0xNullifierRegistry',
    proverPrivateKey: '0xdeadbeef',
    paymentMode: 'disabled',
    a2aBaseUrl: 'http://localhost:4002',
    websiteUrl: 'https://zkproofport.com',
    agentVersion: '1.0.0',
    paymentPayTo: '',
    paymentFacilitatorUrl: 'https://www.x402.org/facilitator',
    paymentProofPrice: '$0.10',
    privyAppId: '',
    privyApiSecret: '',
    privyApiUrl: '',
    signPageUrl: 'http://localhost:4002',
    signingTtlSeconds: 300,
    teeMode: 'disabled',
    enclaveCid: undefined,
    enclavePort: 5000,
    teeAttestationEnabled: false,
    erc8004IdentityAddress: '',
    erc8004ReputationAddress: '',
    erc8004ValidationAddress: '',
    settlementChainRpcUrl: '',
    settlementPrivateKey: '',
    settlementOperatorAddress: '',
    settlementUsdcAddress: '',
    openaiApiKey: '',
    geminiApiKey: '',
    phoenixCollectorEndpoint: '',
    ...overrides,
  } as Config;
}

function makeDataPartMessage(skill: string, extraParams: Record<string, unknown> = {}): Message {
  return {
    role: 'user',
    parts: [{ kind: 'data', data: { skill, ...extraParams } }],
  } as Message;
}

function makeTextPartMessage(text: string): Message {
  return {
    role: 'user',
    parts: [{ kind: 'text', text }],
  } as Message;
}

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    taskId: 'task-abc-123',
    contextId: 'ctx-xyz-789',
    userMessage: makeDataPartMessage('get_supported_circuits'),
    ...overrides,
  } as RequestContext;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProofportExecutor', () => {
  let executor: ProofportExecutor;
  let taskStore: ReturnType<typeof makeTaskStore>;
  let eventBus: ExecutionEventBus;
  let config: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    taskStore = makeTaskStore();
    eventBus = makeEventBus();
    config = makeConfig();
    executor = new ProofportExecutor({
      taskStore: taskStore as any,
      config,
    } as ExecutorDeps);
  });

  // ─── extractSkillFromDataPart ────────────────────────────────────────────

  describe('extractSkillFromDataPart (via execute)', () => {
    it('extracts skill from a DataPart message', async () => {
      const circuits = [{ id: 'coinbase_attestation', displayName: 'Coinbase KYC' }];
      mockHandleGetSupportedCircuits.mockReturnValue({ circuits, chainId: '84532' });

      const ctx = makeContext({
        userMessage: makeDataPartMessage('get_supported_circuits'),
      });

      await executor.execute(ctx, eventBus);

      expect(mockHandleGetSupportedCircuits).toHaveBeenCalledOnce();
    });

    it('extracts additional params from DataPart alongside skill', async () => {
      mockHandleCheckStatus.mockResolvedValue({ requestId: 'req-1', phase: 'signing' });

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('check_status', { requestId: 'req-explicit' }),
      });

      await executor.execute(ctx, eventBus);

      // The first argument to handleCheckStatus should include requestId
      const callArgs = mockHandleCheckStatus.mock.calls[0][0];
      expect(callArgs.requestId).toBe('req-explicit');
    });

    it('ignores non-data parts when looking for DataPart skill', async () => {
      // Message with both text and data parts — data part should win
      const mixedMessage: Message = {
        role: 'user',
        parts: [
          { kind: 'text', text: 'some text that would need LLM' },
          { kind: 'data', data: { skill: 'get_supported_circuits' } },
        ],
      } as Message;

      mockHandleGetSupportedCircuits.mockReturnValue({ circuits: [], chainId: '84532' });

      const ctx = makeContext({ userMessage: mixedMessage });
      await executor.execute(ctx, eventBus);

      expect(mockHandleGetSupportedCircuits).toHaveBeenCalledOnce();
    });
  });

  // ─── resolveSkill priority ───────────────────────────────────────────────

  describe('resolveSkill priority', () => {
    it('DataPart takes priority over TextPart when both are present', async () => {
      const mixedMessage: Message = {
        role: 'user',
        parts: [
          { kind: 'text', text: 'some text' },
          { kind: 'data', data: { skill: 'get_supported_circuits' } },
        ],
      } as Message;

      mockHandleGetSupportedCircuits.mockReturnValue({ circuits: [], chainId: '84532' });
      const mockLlmProvider = { chat: vi.fn() };

      const executorWithLlm = new ProofportExecutor({
        taskStore: taskStore as any,
        config,
        llmProvider: mockLlmProvider as any,
      });

      const ctx = makeContext({ userMessage: mixedMessage });
      await executorWithLlm.execute(ctx, eventBus);

      // LLM should NOT have been consulted — DataPart took priority
      expect(mockLlmProvider.chat).not.toHaveBeenCalled();
      expect(mockHandleGetSupportedCircuits).toHaveBeenCalledOnce();
    });
  });

  // ─── resolveSkill errors ─────────────────────────────────────────────────

  describe('resolveSkill errors', () => {
    it('publishes failed status when message has no text or data parts', async () => {
      const emptyMessage: Message = {
        role: 'user',
        parts: [],
      } as Message;

      const ctx = makeContext({ userMessage: emptyMessage });
      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const statusUpdates = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'status-update')
        .map((call: any[]) => call[0]);

      const failedUpdate = statusUpdates.find((e: any) => e.status?.state === 'failed');
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate.final).toBe(true);
    });

    it('includes error message "no text or data parts" in artifact when parts are empty', async () => {
      const emptyMessage: Message = {
        role: 'user',
        parts: [],
      } as Message;

      const ctx = makeContext({ userMessage: emptyMessage });
      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const artifactUpdates = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'artifact-update')
        .map((call: any[]) => call[0]);

      expect(artifactUpdates.length).toBeGreaterThan(0);
      const errorText = artifactUpdates[0].artifact.parts[0].text as string;
      expect(errorText).toContain('no text or data parts');
    });

    it('publishes failed status when TextPart-only message has no LLM provider', async () => {
      const ctx = makeContext({
        userMessage: makeTextPartMessage('list circuits'),
      });

      // executor has no llmProvider (default)
      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const statusUpdates = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'status-update')
        .map((call: any[]) => call[0]);

      const failedUpdate = statusUpdates.find((e: any) => e.status?.state === 'failed');
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate.final).toBe(true);
    });

    it('error artifact mentions LLM configuration when TextPart fails without LLM', async () => {
      const ctx = makeContext({
        userMessage: makeTextPartMessage('generate a proof'),
      });

      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const artifactUpdates = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'artifact-update')
        .map((call: any[]) => call[0]);

      const errorText = artifactUpdates[0].artifact.parts[0].text as string;
      expect(errorText).toContain('LLM');
    });
  });

  // ─── VALID_SKILLS validation ─────────────────────────────────────────────

  describe('VALID_SKILLS validation', () => {
    it('rejects an invalid skill name with descriptive error', async () => {
      const ctx = makeContext({
        userMessage: makeDataPartMessage('invalid_skill_name'),
      });

      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const artifactUpdates = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'artifact-update')
        .map((call: any[]) => call[0]);

      expect(artifactUpdates.length).toBeGreaterThan(0);
      const errorText = artifactUpdates[0].artifact.parts[0].text as string;
      expect(errorText).toContain('invalid_skill_name');
      expect(errorText).toContain('Invalid skill');
    });

    it('lists valid skills in the error message when skill is invalid', async () => {
      const ctx = makeContext({
        userMessage: makeDataPartMessage('not_a_real_skill'),
      });

      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const artifactUpdates = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'artifact-update')
        .map((call: any[]) => call[0]);

      const errorText = artifactUpdates[0].artifact.parts[0].text as string;
      // Should mention at least one valid skill in the error
      expect(errorText).toContain('get_supported_circuits');
    });

    it('accepts all 6 valid skill names without throwing', async () => {
      const validSkills = [
        'request_signing',
        'check_status',
        'request_payment',
        'generate_proof',
        'verify_proof',
        'get_supported_circuits',
      ];

      mockHandleRequestSigning.mockResolvedValue({ requestId: 'r1', signingUrl: 'http://x' });
      mockHandleCheckStatus.mockResolvedValue({ requestId: 'r1', phase: 'signing' });
      mockHandleRequestPayment.mockResolvedValue({ requestId: 'r1', paymentUrl: 'http://x' });
      mockHandleGenerateProof.mockResolvedValue({ proof: '0x', publicInputs: '0x', nullifier: '0x', signalHash: '0x', proofId: 'p1', verifyUrl: 'http://x' });
      mockHandleVerifyProof.mockResolvedValue({ valid: true, circuitId: 'coinbase_attestation', verifierAddress: '0xVer', chainId: '84532' });
      mockHandleGetSupportedCircuits.mockReturnValue({ circuits: [], chainId: '84532' });

      const expectedStates: Record<string, string> = {
        request_signing: 'input-required',
        check_status: 'input-required',
        request_payment: 'input-required',
        generate_proof: 'completed',
        verify_proof: 'completed',
        get_supported_circuits: 'completed',
      };

      for (const skill of validSkills) {
        vi.clearAllMocks();
        const localEventBus = makeEventBus();
        const ctx = makeContext({
          contextId: '',
          userMessage: makeDataPartMessage(skill),
        });

        await executor.execute(ctx, localEventBus);

        const publishCalls = (localEventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
        const statusUpdates = publishCalls
          .filter((call: any[]) => call[0]?.kind === 'status-update')
          .map((call: any[]) => call[0]);
        const expected = expectedStates[skill];
        const finalUpdate = statusUpdates.find((e: any) => e.status?.state === expected);
        expect(finalUpdate, `skill "${skill}" should return state "${expected}"`).toBeDefined();
      }
    });
  });

  // ─── execute - success flow ──────────────────────────────────────────────

  describe('execute - success flow', () => {
    it('publishes initial Task event as the first publish call', async () => {
      mockHandleGetSupportedCircuits.mockReturnValue({ circuits: [], chainId: '84532' });

      const ctx = makeContext({
        userMessage: makeDataPartMessage('get_supported_circuits'),
      });

      await executor.execute(ctx, eventBus);

      const firstCall = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0];
      const firstEvent = firstCall[0];
      // First event is a Task object (has id and kind='task' or has contextId + history)
      expect(firstEvent.id ?? firstEvent.taskId).toBe(ctx.taskId);
    });

    it('publishes working status event with state=working and final=false before calling skill', async () => {
      mockHandleGetSupportedCircuits.mockReturnValue({ circuits: [], chainId: '84532' });

      const ctx = makeContext({
        userMessage: makeDataPartMessage('get_supported_circuits'),
      });

      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const workingUpdate = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'status-update')
        .map((call: any[]) => call[0])
        .find((e: any) => e.status?.state === 'working');

      expect(workingUpdate).toBeDefined();
      expect(workingUpdate.final).toBe(false);
      expect(workingUpdate.taskId).toBe(ctx.taskId);
      expect(workingUpdate.contextId).toBe(ctx.contextId);
    });

    it('calls get_supported_circuits handler when skill is get_supported_circuits', async () => {
      const mockResult = { circuits: [{ id: 'coinbase_attestation' }], chainId: '84532' };
      mockHandleGetSupportedCircuits.mockReturnValue(mockResult);

      const ctx = makeContext({
        userMessage: makeDataPartMessage('get_supported_circuits', { chainId: '84532' }),
      });

      await executor.execute(ctx, eventBus);

      expect(mockHandleGetSupportedCircuits).toHaveBeenCalledOnce();
      expect(mockHandleGetSupportedCircuits).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: '84532' }),
      );
    });

    it('calls request_signing handler when skill is request_signing', async () => {
      mockHandleRequestSigning.mockResolvedValue({
        requestId: 'req-1',
        signingUrl: 'http://localhost:4002/s/req-1',
        expiresAt: new Date().toISOString(),
        circuitId: 'coinbase_attestation',
        scope: 'test.com',
      });

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('request_signing', {
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
        }),
      });

      await executor.execute(ctx, eventBus);

      expect(mockHandleRequestSigning).toHaveBeenCalledOnce();
    });

    it('calls generate_proof handler when skill is generate_proof', async () => {
      mockHandleGenerateProof.mockResolvedValue({
        proof: '0xproof',
        publicInputs: '0xinputs',
        nullifier: '0xnullifier',
        signalHash: '0xhash',
        proofId: 'proof-id-1',
        verifyUrl: 'http://localhost:4002/v/proof-id-1',
      });

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('generate_proof', { requestId: 'req-999' }),
      });

      await executor.execute(ctx, eventBus);

      expect(mockHandleGenerateProof).toHaveBeenCalledOnce();
    });

    it('publishes artifact-update event with TextPart and DataPart containing result', async () => {
      const mockResult = { circuits: [{ id: 'coinbase_attestation' }], chainId: '84532' };
      mockHandleGetSupportedCircuits.mockReturnValue(mockResult);

      const ctx = makeContext({
        userMessage: makeDataPartMessage('get_supported_circuits'),
      });

      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const artifactUpdates = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'artifact-update')
        .map((call: any[]) => call[0]);

      expect(artifactUpdates.length).toBe(1);
      const artifact = artifactUpdates[0].artifact;

      const textPart = artifact.parts.find((p: any) => p.kind === 'text');
      const dataPart = artifact.parts.find((p: any) => p.kind === 'data');

      expect(textPart).toBeDefined();
      expect(textPart.text).toContain('Found');
      expect(dataPart).toBeDefined();
      expect(dataPart.data).toEqual(mockResult);
    });

    it('artifact-update event has lastChunk=true', async () => {
      mockHandleGetSupportedCircuits.mockReturnValue({ circuits: [], chainId: '84532' });

      const ctx = makeContext({
        userMessage: makeDataPartMessage('get_supported_circuits'),
      });

      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const artifactUpdate = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'artifact-update')
        .map((call: any[]) => call[0])[0];

      expect(artifactUpdate.lastChunk).toBe(true);
    });

    it('publishes completed status with state=completed and final=true after skill succeeds', async () => {
      mockHandleGetSupportedCircuits.mockReturnValue({ circuits: [], chainId: '84532' });

      const ctx = makeContext({
        userMessage: makeDataPartMessage('get_supported_circuits'),
      });

      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const completedUpdate = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'status-update')
        .map((call: any[]) => call[0])
        .find((e: any) => e.status?.state === 'completed');

      expect(completedUpdate).toBeDefined();
      expect(completedUpdate.final).toBe(true);
      expect(completedUpdate.taskId).toBe(ctx.taskId);
    });

    it('calls eventBus.finished() after success', async () => {
      mockHandleGetSupportedCircuits.mockReturnValue({ circuits: [], chainId: '84532' });

      const ctx = makeContext({
        userMessage: makeDataPartMessage('get_supported_circuits'),
      });

      await executor.execute(ctx, eventBus);

      expect(eventBus.finished).toHaveBeenCalledOnce();
    });

    it('event order is: Task → working → artifact → completed', async () => {
      mockHandleGetSupportedCircuits.mockReturnValue({ circuits: [], chainId: '84532' });

      const ctx = makeContext({
        userMessage: makeDataPartMessage('get_supported_circuits'),
      });

      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const events = publishCalls.map((call: any[]) => {
        const e = call[0];
        if (e.kind === 'status-update') return `status:${e.status?.state}`;
        if (e.kind === 'artifact-update') return 'artifact';
        if (e.id) return 'task';
        return 'unknown';
      });

      expect(events[0]).toBe('task');
      expect(events).toContain('status:working');
      expect(events).toContain('artifact');
      expect(events).toContain('status:completed');

      const workingIdx = events.indexOf('status:working');
      const artifactIdx = events.indexOf('artifact');
      const completedIdx = events.indexOf('status:completed');
      expect(workingIdx).toBeLessThan(artifactIdx);
      expect(artifactIdx).toBeLessThan(completedIdx);
    });
  });

  // ─── execute - context flow auto-resolution ──────────────────────────────

  describe('execute - context flow auto-resolution', () => {
    it('auto-fills requestId for check_status when contextId has a stored requestId', async () => {
      const storedRequestId = 'req-stored-from-context';
      taskStore.getContextFlow = vi.fn().mockResolvedValue(storedRequestId);

      mockHandleCheckStatus.mockResolvedValue({ requestId: storedRequestId, phase: 'signing' });

      const ctx = makeContext({
        contextId: 'ctx-with-flow',
        userMessage: makeDataPartMessage('check_status'), // no requestId in params
      });

      await executor.execute(ctx, eventBus);

      const callArgs = mockHandleCheckStatus.mock.calls[0][0];
      expect(callArgs.requestId).toBe(storedRequestId);
    });

    it('auto-fills requestId for request_payment when contextId has a stored requestId', async () => {
      const storedRequestId = 'req-pay-from-context';
      taskStore.getContextFlow = vi.fn().mockResolvedValue(storedRequestId);

      mockHandleRequestPayment.mockResolvedValue({
        requestId: storedRequestId,
        paymentUrl: 'http://x',
        amount: '$0.10',
        currency: 'USDC',
        network: 'Base Sepolia',
      });

      const ctx = makeContext({
        contextId: 'ctx-pay',
        userMessage: makeDataPartMessage('request_payment'), // no requestId in params
      });

      await executor.execute(ctx, eventBus);

      const callArgs = mockHandleRequestPayment.mock.calls[0][0];
      expect(callArgs.requestId).toBe(storedRequestId);
    });

    it('auto-fills requestId for generate_proof when contextId has a stored requestId', async () => {
      const storedRequestId = 'req-gen-from-context';
      taskStore.getContextFlow = vi.fn().mockResolvedValue(storedRequestId);

      mockHandleGenerateProof.mockResolvedValue({
        proof: '0xproof',
        publicInputs: '0xinputs',
        nullifier: '0xnull',
        signalHash: '0xhash',
        proofId: 'pid-1',
        verifyUrl: 'http://x',
      });

      const ctx = makeContext({
        contextId: 'ctx-gen',
        userMessage: makeDataPartMessage('generate_proof'), // no requestId
      });

      await executor.execute(ctx, eventBus);

      const callArgs = mockHandleGenerateProof.mock.calls[0][0];
      expect(callArgs.requestId).toBe(storedRequestId);
    });

    it('does NOT auto-fill requestId when params already contain requestId', async () => {
      const storedRequestId = 'req-from-context';
      const explicitRequestId = 'req-explicit-in-params';
      taskStore.getContextFlow = vi.fn().mockResolvedValue(storedRequestId);

      mockHandleCheckStatus.mockResolvedValue({ requestId: explicitRequestId, phase: 'signing' });

      const ctx = makeContext({
        contextId: 'ctx-explicit',
        userMessage: makeDataPartMessage('check_status', { requestId: explicitRequestId }),
      });

      await executor.execute(ctx, eventBus);

      // explicitRequestId must NOT be overwritten by the context flow
      const callArgs = mockHandleCheckStatus.mock.calls[0][0];
      expect(callArgs.requestId).toBe(explicitRequestId);
    });

    it('does NOT auto-fill requestId for request_signing skill', async () => {
      const storedRequestId = 'req-should-not-be-used';
      taskStore.getContextFlow = vi.fn().mockResolvedValue(storedRequestId);

      mockHandleRequestSigning.mockResolvedValue({
        requestId: 'req-new',
        signingUrl: 'http://x',
        expiresAt: new Date().toISOString(),
        circuitId: 'coinbase_attestation',
        scope: 'test.com',
      });

      const ctx = makeContext({
        contextId: 'ctx-sign',
        userMessage: makeDataPartMessage('request_signing', {
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
        }),
      });

      await executor.execute(ctx, eventBus);

      // request_signing should not receive requestId from context flow
      const callArgs = mockHandleRequestSigning.mock.calls[0][0];
      expect(callArgs.requestId).toBeUndefined();
    });

    it('does NOT auto-fill requestId for get_supported_circuits skill', async () => {
      const storedRequestId = 'req-should-not-be-used';
      taskStore.getContextFlow = vi.fn().mockResolvedValue(storedRequestId);

      mockHandleGetSupportedCircuits.mockReturnValue({ circuits: [], chainId: '84532' });

      const ctx = makeContext({
        contextId: 'ctx-circuits',
        userMessage: makeDataPartMessage('get_supported_circuits'),
      });

      await executor.execute(ctx, eventBus);

      const callArgs = mockHandleGetSupportedCircuits.mock.calls[0][0];
      expect(callArgs.requestId).toBeUndefined();
    });

    it('stores contextId→requestId mapping after successful request_signing', async () => {
      const newRequestId = 'req-newly-created';
      mockHandleRequestSigning.mockResolvedValue({
        requestId: newRequestId,
        signingUrl: 'http://x',
        expiresAt: new Date().toISOString(),
        circuitId: 'coinbase_attestation',
        scope: 'test.com',
      });

      const ctx = makeContext({
        contextId: 'ctx-to-store',
        userMessage: makeDataPartMessage('request_signing', {
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
        }),
      });

      await executor.execute(ctx, eventBus);

      expect(taskStore.setContextFlow).toHaveBeenCalledWith('ctx-to-store', newRequestId);
    });

    it('does not call setContextFlow when contextId is empty', async () => {
      mockHandleRequestSigning.mockResolvedValue({
        requestId: 'req-no-ctx',
        signingUrl: 'http://x',
        expiresAt: new Date().toISOString(),
        circuitId: 'coinbase_attestation',
        scope: 'test.com',
      });

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('request_signing', {
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
        }),
      });

      await executor.execute(ctx, eventBus);

      expect(taskStore.setContextFlow).not.toHaveBeenCalled();
    });

    it('proceeds without error when getContextFlow throws', async () => {
      taskStore.getContextFlow = vi.fn().mockRejectedValue(new Error('Redis connection failed'));

      mockHandleGetSupportedCircuits.mockReturnValue({ circuits: [], chainId: '84532' });

      const ctx = makeContext({
        contextId: 'ctx-redis-fail',
        userMessage: makeDataPartMessage('get_supported_circuits'),
      });

      // Should NOT throw — error is swallowed internally
      await expect(executor.execute(ctx, eventBus)).resolves.toBeUndefined();

      // Task should still complete successfully
      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const completedUpdate = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'status-update')
        .map((call: any[]) => call[0])
        .find((e: any) => e.status?.state === 'completed');
      expect(completedUpdate).toBeDefined();
    });
  });

  // ─── execute - error handling ────────────────────────────────────────────

  describe('execute - error handling', () => {
    it('publishes error artifact with the error message when skill throws', async () => {
      const errorMsg = 'Signing not yet completed';
      mockHandleCheckStatus.mockRejectedValue(new Error(errorMsg));

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('check_status', { requestId: 'req-1' }),
      });

      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const artifactUpdates = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'artifact-update')
        .map((call: any[]) => call[0]);

      expect(artifactUpdates.length).toBe(1);
      const errorText = artifactUpdates[0].artifact.parts[0].text as string;
      expect(errorText).toBe(errorMsg);
    });

    it('error artifact has lastChunk=true', async () => {
      mockHandleCheckStatus.mockRejectedValue(new Error('fail'));

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('check_status', { requestId: 'req-1' }),
      });

      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const artifactUpdate = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'artifact-update')
        .map((call: any[]) => call[0])[0];

      expect(artifactUpdate.lastChunk).toBe(true);
    });

    it('publishes failed status with state=failed and final=true when skill throws', async () => {
      mockHandleGenerateProof.mockRejectedValue(new Error('Proof generation failed'));

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('generate_proof', { requestId: 'req-1' }),
      });

      await executor.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const failedUpdate = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'status-update')
        .map((call: any[]) => call[0])
        .find((e: any) => e.status?.state === 'failed');

      expect(failedUpdate).toBeDefined();
      expect(failedUpdate.final).toBe(true);
      expect(failedUpdate.taskId).toBe(ctx.taskId);
    });

    it('calls eventBus.finished() even when skill throws', async () => {
      mockHandleGenerateProof.mockRejectedValue(new Error('Fatal error'));

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('generate_proof', { requestId: 'req-1' }),
      });

      await executor.execute(ctx, eventBus);

      expect(eventBus.finished).toHaveBeenCalledOnce();
    });

    it('does not throw from execute() when skill rejects — returns undefined', async () => {
      mockHandleVerifyProof.mockRejectedValue(new Error('Contract reverted'));

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('verify_proof', { proofId: 'pid-1' }),
      });

      await expect(executor.execute(ctx, eventBus)).resolves.toBeUndefined();
    });

    it('uses ctx.task if already present instead of constructing initial Task from scratch', async () => {
      const existingTask: Task = {
        id: 'task-existing',
        contextId: 'ctx-existing',
        status: { state: 'submitted', timestamp: new Date().toISOString() },
        history: [],
        kind: 'task',
      } as unknown as Task;

      mockHandleGetSupportedCircuits.mockReturnValue({ circuits: [], chainId: '84532' });

      const ctx = makeContext({
        taskId: 'task-existing',
        contextId: 'ctx-existing',
        task: existingTask,
        userMessage: makeDataPartMessage('get_supported_circuits'),
      });

      await executor.execute(ctx, eventBus);

      // First publish call must be the existing task
      const firstPublish = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(firstPublish).toBe(existingTask);
    });
  });

  // ─── ERC-8004 reputation ─────────────────────────────────────────────────

  describe('ERC-8004 reputation', () => {
    it('calls handleProofCompleted after generate_proof success when erc8004ReputationAddress is set', async () => {
      const configWithReputation = makeConfig({
        erc8004ReputationAddress: '0xReputationContract',
        chainRpcUrl: 'https://sepolia.base.org',
        proverPrivateKey: '0xprivkey',
      });

      const executorWithReputation = new ProofportExecutor({
        taskStore: taskStore as any,
        config: configWithReputation,
      } as ExecutorDeps);

      mockHandleGenerateProof.mockResolvedValue({
        proof: '0xproof',
        publicInputs: '0xinputs',
        nullifier: '0xnull',
        signalHash: '0xhash',
        proofId: 'pid-rep',
        verifyUrl: 'http://x',
      });

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('generate_proof', { requestId: 'req-1' }),
      });

      await executorWithReputation.execute(ctx, eventBus);

      // Allow microtask queue to flush (non-blocking call)
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockHandleProofCompleted).toHaveBeenCalledOnce();
      expect(mockHandleProofCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          reputationContractAddress: '0xReputationContract',
          chainRpcUrl: 'https://sepolia.base.org',
          privateKey: '0xprivkey',
        }),
        '0x1234', // signer.address from mock Wallet
      );
    });

    it('does NOT call handleProofCompleted when erc8004ReputationAddress is empty', async () => {
      // Default config has erc8004ReputationAddress: ''
      mockHandleGenerateProof.mockResolvedValue({
        proof: '0xproof',
        publicInputs: '0xinputs',
        nullifier: '0xnull',
        signalHash: '0xhash',
        proofId: 'pid-2',
        verifyUrl: 'http://x',
      });

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('generate_proof', { requestId: 'req-2' }),
      });

      await executor.execute(ctx, eventBus);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockHandleProofCompleted).not.toHaveBeenCalled();
    });

    it('does NOT call handleProofCompleted for other skills even with reputation address set', async () => {
      const configWithReputation = makeConfig({
        erc8004ReputationAddress: '0xReputationContract',
      });

      const executorWithReputation = new ProofportExecutor({
        taskStore: taskStore as any,
        config: configWithReputation,
      } as ExecutorDeps);

      mockHandleVerifyProof.mockResolvedValue({
        valid: true,
        circuitId: 'coinbase_attestation',
        verifierAddress: '0xVerifier',
        chainId: '84532',
      });

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('verify_proof', { proofId: 'pid-3' }),
      });

      await executorWithReputation.execute(ctx, eventBus);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockHandleProofCompleted).not.toHaveBeenCalled();
    });

    it('reputation failure does not affect task completion — completed status still published', async () => {
      const configWithReputation = makeConfig({
        erc8004ReputationAddress: '0xReputationContract',
      });

      mockHandleProofCompleted.mockRejectedValue(new Error('On-chain call failed'));

      const executorWithReputation = new ProofportExecutor({
        taskStore: taskStore as any,
        config: configWithReputation,
      } as ExecutorDeps);

      mockHandleGenerateProof.mockResolvedValue({
        proof: '0xproof',
        publicInputs: '0xinputs',
        nullifier: '0xnull',
        signalHash: '0xhash',
        proofId: 'pid-rep-fail',
        verifyUrl: 'http://x',
      });

      const ctx = makeContext({
        contextId: '',
        userMessage: makeDataPartMessage('generate_proof', { requestId: 'req-rep-fail' }),
      });

      await executorWithReputation.execute(ctx, eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const completedUpdate = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'status-update')
        .map((call: any[]) => call[0])
        .find((e: any) => e.status?.state === 'completed');

      expect(completedUpdate).toBeDefined();
      expect(completedUpdate.final).toBe(true);
    });
  });

  // ─── cancelTask ──────────────────────────────────────────────────────────

  describe('cancelTask', () => {
    it('publishes canceled status with state=canceled and final=true', async () => {
      await executor.cancelTask('task-to-cancel', eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const canceledUpdate = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'status-update')
        .map((call: any[]) => call[0])
        .find((e: any) => e.status?.state === 'canceled');

      expect(canceledUpdate).toBeDefined();
      expect(canceledUpdate.final).toBe(true);
      expect(canceledUpdate.taskId).toBe('task-to-cancel');
    });

    it('calls eventBus.finished() after publishing canceled status', async () => {
      await executor.cancelTask('task-cancel-2', eventBus);

      expect(eventBus.finished).toHaveBeenCalledOnce();
    });

    it('canceled status event has empty contextId', async () => {
      await executor.cancelTask('task-cancel-3', eventBus);

      const publishCalls = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const canceledUpdate = publishCalls
        .filter((call: any[]) => call[0]?.kind === 'status-update')
        .map((call: any[]) => call[0])
        .find((e: any) => e.status?.state === 'canceled');

      expect(canceledUpdate.contextId).toBe('');
    });

    it('does not call any skill handler when task is canceled', async () => {
      await executor.cancelTask('task-cancel-4', eventBus);

      expect(mockHandleGetSupportedCircuits).not.toHaveBeenCalled();
      expect(mockHandleGenerateProof).not.toHaveBeenCalled();
      expect(mockHandleRequestSigning).not.toHaveBeenCalled();
    });
  });
});
