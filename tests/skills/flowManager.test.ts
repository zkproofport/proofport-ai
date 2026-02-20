import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock variables (available inside vi.mock factories) ──────────────

const {
  MOCK_FLOW_ID,
  mockHandleRequestSigning,
  mockHandleCheckStatus,
  mockHandleRequestPayment,
  mockHandleGenerateProof,
} = vi.hoisted(() => {
  return {
    MOCK_FLOW_ID: 'flow-uuid-1234-abcd-efgh-ijklmnopqrst',
    mockHandleRequestSigning: vi.fn(),
    mockHandleCheckStatus: vi.fn(),
    mockHandleRequestPayment: vi.fn(),
    mockHandleGenerateProof: vi.fn(),
  };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => MOCK_FLOW_ID),
}));

vi.mock('../../src/skills/skillHandler.js', () => ({
  handleRequestSigning: (...args: unknown[]) => mockHandleRequestSigning(...args),
  handleCheckStatus: (...args: unknown[]) => mockHandleCheckStatus(...args),
  handleRequestPayment: (...args: unknown[]) => mockHandleRequestPayment(...args),
  handleGenerateProof: (...args: unknown[]) => mockHandleGenerateProof(...args),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  createFlow,
  advanceFlow,
  getFlow,
  getFlowByRequestId,
  type ProofFlow,
} from '../../src/skills/flowManager.js';
import type { SkillDeps } from '../../src/skills/skillHandler.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createMockRedis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(300),
    publish: vi.fn().mockResolvedValue(1),
    incr: vi.fn(),
    expire: vi.fn(),
  };
}

function createMockDeps(overrides: Partial<SkillDeps> = {}): SkillDeps {
  return {
    redis: createMockRedis() as unknown as SkillDeps['redis'],
    signPageUrl: 'https://ai.zkproofport.app',
    signingTtlSeconds: 300,
    paymentMode: 'disabled',
    paymentProofPrice: '$0.10',
    easGraphqlEndpoint: 'https://base.easscan.org/graphql',
    rpcUrls: ['https://sepolia.base.org'],
    bbPath: '/usr/local/bin/bb',
    nargoPath: '/usr/local/bin/nargo',
    circuitsDir: '/circuits',
    chainRpcUrl: 'https://sepolia.base.org',
    teeMode: 'disabled',
    ...overrides,
  };
}

const MOCK_REQUEST_ID = 'req-abc-123';
const MOCK_SIGNING_URL = 'https://ai.zkproofport.app/s/req-abc-123';
const MOCK_EXPIRES_AT = new Date(Date.now() + 300_000).toISOString();

function makeSigningResult(overrides: Record<string, unknown> = {}) {
  return {
    requestId: MOCK_REQUEST_ID,
    signingUrl: MOCK_SIGNING_URL,
    expiresAt: MOCK_EXPIRES_AT,
    circuitId: 'coinbase_attestation',
    scope: 'my-dapp',
    ...overrides,
  };
}

function makeProofFlow(overrides: Partial<ProofFlow> = {}): ProofFlow {
  const now = new Date().toISOString();
  return {
    flowId: MOCK_FLOW_ID,
    circuitId: 'coinbase_attestation',
    scope: 'my-dapp',
    phase: 'signing',
    requestId: MOCK_REQUEST_ID,
    signingUrl: MOCK_SIGNING_URL,
    createdAt: now,
    updatedAt: now,
    expiresAt: MOCK_EXPIRES_AT,
    ...overrides,
  };
}

function makeCheckStatusResult(phase: 'signing' | 'payment' | 'ready' | 'expired') {
  return {
    requestId: MOCK_REQUEST_ID,
    phase,
    signing: { status: phase === 'signing' ? 'pending' : 'completed' },
    payment: { status: 'not_required' },
    expiresAt: MOCK_EXPIRES_AT,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('flowManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // createFlow
  // ═══════════════════════════════════════════════════════════════════════════

  describe('createFlow', () => {
    it('creates flow with correct structure', async () => {
      const deps = createMockDeps();
      mockHandleRequestSigning.mockResolvedValue(makeSigningResult());

      const flow = await createFlow(
        { circuitId: 'coinbase_attestation', scope: 'my-dapp' },
        deps,
      );

      expect(flow.flowId).toBe(MOCK_FLOW_ID);
      expect(flow.phase).toBe('signing');
      expect(flow.signingUrl).toBe(MOCK_SIGNING_URL);
      expect(flow.requestId).toBe(MOCK_REQUEST_ID);
      expect(flow.circuitId).toBe('coinbase_attestation');
      expect(flow.scope).toBe('my-dapp');
      expect(flow.expiresAt).toBe(MOCK_EXPIRES_AT);
      expect(flow.createdAt).toBeDefined();
      expect(flow.updatedAt).toBeDefined();
    });

    it('stores flow in Redis with key pattern flow:{flowId}', async () => {
      const deps = createMockDeps();
      mockHandleRequestSigning.mockResolvedValue(makeSigningResult());

      await createFlow({ circuitId: 'coinbase_attestation', scope: 'my-dapp' }, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      const setCalls = redis.set.mock.calls;
      const flowKeyCall = setCalls.find((c) => c[0] === `flow:${MOCK_FLOW_ID}`);
      expect(flowKeyCall).toBeDefined();
      expect(flowKeyCall![2]).toBe('EX');
      expect(flowKeyCall![3]).toBe(300);

      const stored = JSON.parse(flowKeyCall![1]);
      expect(stored.flowId).toBe(MOCK_FLOW_ID);
      expect(stored.phase).toBe('signing');
      expect(stored.requestId).toBe(MOCK_REQUEST_ID);
    });

    it('stores reverse lookup flow:req:{requestId} → flowId', async () => {
      const deps = createMockDeps();
      mockHandleRequestSigning.mockResolvedValue(makeSigningResult());

      await createFlow({ circuitId: 'coinbase_attestation', scope: 'my-dapp' }, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      const setCalls = redis.set.mock.calls;
      const reqKeyCall = setCalls.find((c) => c[0] === `flow:req:${MOCK_REQUEST_ID}`);
      expect(reqKeyCall).toBeDefined();
      expect(reqKeyCall![1]).toBe(MOCK_FLOW_ID);
      expect(reqKeyCall![2]).toBe('EX');
      expect(reqKeyCall![3]).toBe(300);
    });

    it('makes exactly two Redis set calls (main flow + reverse lookup)', async () => {
      const deps = createMockDeps();
      mockHandleRequestSigning.mockResolvedValue(makeSigningResult());

      await createFlow({ circuitId: 'coinbase_attestation', scope: 'my-dapp' }, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      expect(redis.set).toHaveBeenCalledTimes(2);
    });

    it('includes optional countryList and isIncluded when provided', async () => {
      const deps = createMockDeps();
      mockHandleRequestSigning.mockResolvedValue(makeSigningResult({
        circuitId: 'coinbase_country_attestation',
        scope: 'country-scope',
      }));

      const flow = await createFlow(
        {
          circuitId: 'coinbase_country_attestation',
          scope: 'country-scope',
          countryList: ['US', 'CA'],
          isIncluded: true,
        },
        deps,
      );

      expect(flow.countryList).toEqual(['US', 'CA']);
      expect(flow.isIncluded).toBe(true);
    });

    it('omits countryList and isIncluded when not provided', async () => {
      const deps = createMockDeps();
      mockHandleRequestSigning.mockResolvedValue(makeSigningResult());

      const flow = await createFlow(
        { circuitId: 'coinbase_attestation', scope: 'my-dapp' },
        deps,
      );

      expect(flow.countryList).toBeUndefined();
      expect(flow.isIncluded).toBeUndefined();
    });

    it('throws on missing circuitId', async () => {
      const deps = createMockDeps();

      await expect(
        createFlow({ circuitId: '', scope: 'my-dapp' }, deps),
      ).rejects.toThrow('circuitId is required');
    });

    it('throws on missing scope', async () => {
      const deps = createMockDeps();

      await expect(
        createFlow({ circuitId: 'coinbase_attestation', scope: '' }, deps),
      ).rejects.toThrow('scope is required');
    });

    it('throws on whitespace-only scope', async () => {
      const deps = createMockDeps();

      await expect(
        createFlow({ circuitId: 'coinbase_attestation', scope: '   ' }, deps),
      ).rejects.toThrow('scope is required');
    });

    it('throws when handleRequestSigning fails', async () => {
      const deps = createMockDeps();
      mockHandleRequestSigning.mockRejectedValue(new Error('Signing service unavailable'));

      await expect(
        createFlow({ circuitId: 'coinbase_attestation', scope: 'my-dapp' }, deps),
      ).rejects.toThrow('Signing service unavailable');

      // No Redis writes should have happened
      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('passes correct params to handleRequestSigning', async () => {
      const deps = createMockDeps();
      mockHandleRequestSigning.mockResolvedValue(makeSigningResult());

      await createFlow(
        {
          circuitId: 'coinbase_country_attestation',
          scope: 'test-scope',
          countryList: ['US'],
          isIncluded: false,
        },
        deps,
      );

      expect(mockHandleRequestSigning).toHaveBeenCalledWith(
        {
          circuitId: 'coinbase_country_attestation',
          scope: 'test-scope',
          countryList: ['US'],
          isIncluded: false,
        },
        deps,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // advanceFlow
  // ═══════════════════════════════════════════════════════════════════════════

  describe('advanceFlow', () => {
    it('returns flow as-is when phase is completed (terminal)', async () => {
      const flow = makeProofFlow({ phase: 'completed' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));

      const result = await advanceFlow(MOCK_FLOW_ID, deps);

      expect(result.phase).toBe('completed');
      expect(mockHandleCheckStatus).not.toHaveBeenCalled();
    });

    it('returns flow as-is when phase is failed (terminal)', async () => {
      const flow = makeProofFlow({ phase: 'failed', error: 'proof failed' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));

      const result = await advanceFlow(MOCK_FLOW_ID, deps);

      expect(result.phase).toBe('failed');
      expect(mockHandleCheckStatus).not.toHaveBeenCalled();
    });

    it('returns flow as-is when phase is expired (terminal)', async () => {
      const flow = makeProofFlow({ phase: 'expired' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));

      const result = await advanceFlow(MOCK_FLOW_ID, deps);

      expect(result.phase).toBe('expired');
      expect(mockHandleCheckStatus).not.toHaveBeenCalled();
    });

    it('returns flow unchanged when check_status shows signing (waiting for user)', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('signing'));

      const result = await advanceFlow(MOCK_FLOW_ID, deps);

      expect(result.phase).toBe('signing');
      // No save, no publish — flow unchanged
      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('transitions signing → payment when check_status shows payment', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('payment'));
      mockHandleRequestPayment.mockResolvedValue({
        requestId: MOCK_REQUEST_ID,
        paymentUrl: 'https://ai.zkproofport.app/pay/req-abc-123',
        amount: '$0.10',
        currency: 'USDC',
        network: 'Base Sepolia',
      });

      const result = await advanceFlow(MOCK_FLOW_ID, deps);

      expect(result.phase).toBe('payment');
      expect(result.paymentUrl).toBe('https://ai.zkproofport.app/pay/req-abc-123');
    });

    it('calls handleRequestPayment on transition to payment', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('payment'));
      mockHandleRequestPayment.mockResolvedValue({
        requestId: MOCK_REQUEST_ID,
        paymentUrl: 'https://ai.zkproofport.app/pay/req-abc-123',
        amount: '$0.10',
        currency: 'USDC',
        network: 'Base Sepolia',
      });

      await advanceFlow(MOCK_FLOW_ID, deps);

      expect(mockHandleRequestPayment).toHaveBeenCalledWith(
        { requestId: MOCK_REQUEST_ID },
        deps,
      );
    });

    it('stores paymentUrl in flow on transition to payment', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('payment'));
      mockHandleRequestPayment.mockResolvedValue({
        requestId: MOCK_REQUEST_ID,
        paymentUrl: 'https://ai.zkproofport.app/pay/req-abc-123',
        amount: '$0.10',
        currency: 'USDC',
        network: 'Base Sepolia',
      });

      await advanceFlow(MOCK_FLOW_ID, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      const setCall = redis.set.mock.calls.find((c) => c[0] === `flow:${MOCK_FLOW_ID}`);
      expect(setCall).toBeDefined();
      const saved = JSON.parse(setCall![1]);
      expect(saved.phase).toBe('payment');
      expect(saved.paymentUrl).toBe('https://ai.zkproofport.app/pay/req-abc-123');
    });

    it('returns payment flow unchanged when already in payment phase and status is still payment', async () => {
      const flow = makeProofFlow({
        phase: 'payment',
        paymentUrl: 'https://ai.zkproofport.app/pay/req-abc-123',
      });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('payment'));

      const result = await advanceFlow(MOCK_FLOW_ID, deps);

      expect(result.phase).toBe('payment');
      // handleRequestPayment should NOT be called again
      expect(mockHandleRequestPayment).not.toHaveBeenCalled();
      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('transitions to generating then completed when check_status shows ready', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('ready'));
      mockHandleGenerateProof.mockResolvedValue({
        proof: '0xproof',
        publicInputs: '0xpubinputs',
        nullifier: '0xnullifier',
        signalHash: '0xsignalhash',
        proofId: 'proof-id-xyz',
        verifyUrl: 'https://ai.zkproofport.app/v/proof-id-xyz',
      });

      const result = await advanceFlow(MOCK_FLOW_ID, deps);

      expect(result.phase).toBe('completed');
      expect(result.proofResult).toBeDefined();
      expect(result.proofResult!.proofId).toBe('proof-id-xyz');
    });

    it('publishes generating event before calling handleGenerateProof', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('ready'));

      const publishCalls: string[] = [];
      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      redis.publish.mockImplementation((_channel: string, payload: string) => {
        publishCalls.push(JSON.parse(payload).phase);
        return Promise.resolve(1);
      });

      mockHandleGenerateProof.mockResolvedValue({
        proof: '0xproof',
        publicInputs: '0xpubinputs',
        nullifier: '0xnullifier',
        signalHash: '0xsignalhash',
        proofId: 'proof-id-xyz',
        verifyUrl: 'https://ai.zkproofport.app/v/proof-id-xyz',
      });

      await advanceFlow(MOCK_FLOW_ID, deps);

      // Should have published generating, then completed
      expect(publishCalls).toContain('generating');
      expect(publishCalls).toContain('completed');
      const generatingIndex = publishCalls.indexOf('generating');
      const completedIndex = publishCalls.indexOf('completed');
      expect(generatingIndex).toBeLessThan(completedIndex);
    });

    it('transitions to failed when handleGenerateProof throws', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('ready'));
      mockHandleGenerateProof.mockRejectedValue(new Error('bb CLI crashed'));

      const result = await advanceFlow(MOCK_FLOW_ID, deps);

      expect(result.phase).toBe('failed');
      expect(result.error).toBe('bb CLI crashed');
    });

    it('stores error message when handleGenerateProof throws', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('ready'));
      mockHandleGenerateProof.mockRejectedValue(new Error('proof gen error'));

      await advanceFlow(MOCK_FLOW_ID, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      // The final save after failed proof gen
      const setCalls = redis.set.mock.calls.filter((c) => c[0] === `flow:${MOCK_FLOW_ID}`);
      const lastSavedFlow = JSON.parse(setCalls[setCalls.length - 1][1]);
      expect(lastSavedFlow.phase).toBe('failed');
      expect(lastSavedFlow.error).toBe('proof gen error');
    });

    it('transitions to expired when check_status shows expired', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('expired'));

      const result = await advanceFlow(MOCK_FLOW_ID, deps);

      expect(result.phase).toBe('expired');
    });

    it('publishes flow event on expired transition', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('expired'));

      await advanceFlow(MOCK_FLOW_ID, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      expect(redis.publish).toHaveBeenCalledWith(
        `flow:events:${MOCK_FLOW_ID}`,
        expect.stringContaining('"phase":"expired"'),
      );
    });

    it('publishes flow event on payment transition', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('payment'));
      mockHandleRequestPayment.mockResolvedValue({
        requestId: MOCK_REQUEST_ID,
        paymentUrl: 'https://ai.zkproofport.app/pay/req-abc-123',
        amount: '$0.10',
        currency: 'USDC',
        network: 'Base Sepolia',
      });

      await advanceFlow(MOCK_FLOW_ID, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      expect(redis.publish).toHaveBeenCalledWith(
        `flow:events:${MOCK_FLOW_ID}`,
        expect.stringContaining('"phase":"payment"'),
      );
    });

    it('publishes flow event on completed transition', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('ready'));
      mockHandleGenerateProof.mockResolvedValue({
        proof: '0xproof',
        publicInputs: '0xpubinputs',
        nullifier: '0xnullifier',
        signalHash: '0xsignalhash',
        proofId: 'proof-id-xyz',
        verifyUrl: 'https://ai.zkproofport.app/v/proof-id-xyz',
      });

      await advanceFlow(MOCK_FLOW_ID, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      const publishedPhases = redis.publish.mock.calls.map((c) => JSON.parse(c[1]).phase);
      expect(publishedPhases).toContain('completed');
    });

    it('publishes to channel flow:events:{flowId}', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('expired'));

      await advanceFlow(MOCK_FLOW_ID, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      expect(redis.publish).toHaveBeenCalledWith(
        `flow:events:${MOCK_FLOW_ID}`,
        expect.any(String),
      );
    });

    it('throws when flowId is empty', async () => {
      const deps = createMockDeps();

      await expect(advanceFlow('', deps)).rejects.toThrow('flowId is required');
    });

    it('throws when flow is not found in Redis', async () => {
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(advanceFlow('nonexistent-flow-id', deps)).rejects.toThrow('Flow not found');
    });

    it('passes requestId to handleCheckStatus', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('signing'));

      await advanceFlow(MOCK_FLOW_ID, deps);

      expect(mockHandleCheckStatus).toHaveBeenCalledWith(
        { requestId: MOCK_REQUEST_ID },
        deps,
      );
    });

    it('uses TTL from Redis when saving updated flow', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      (deps.redis.ttl as ReturnType<typeof vi.fn>).mockResolvedValue(180);
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('expired'));

      await advanceFlow(MOCK_FLOW_ID, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      const setCall = redis.set.mock.calls.find((c) => c[0] === `flow:${MOCK_FLOW_ID}`);
      expect(setCall).toBeDefined();
      expect(setCall![3]).toBe(180);
    });

    it('falls back to signingTtlSeconds when Redis TTL is 0 or negative', async () => {
      const flow = makeProofFlow({ phase: 'signing' });
      const deps = createMockDeps({ signingTtlSeconds: 300 });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      (deps.redis.ttl as ReturnType<typeof vi.fn>).mockResolvedValue(-1);
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('expired'));

      await advanceFlow(MOCK_FLOW_ID, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      const setCall = redis.set.mock.calls.find((c) => c[0] === `flow:${MOCK_FLOW_ID}`);
      expect(setCall).toBeDefined();
      expect(setCall![3]).toBe(300);
    });

    it('returns flow unchanged when phase is already generating', async () => {
      const flow = makeProofFlow({ phase: 'generating' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(flow));
      mockHandleCheckStatus.mockResolvedValue(makeCheckStatusResult('ready'));

      const result = await advanceFlow(MOCK_FLOW_ID, deps);

      expect(result.phase).toBe('generating');
      expect(mockHandleGenerateProof).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getFlow
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getFlow', () => {
    it('returns ProofFlow when found in Redis', async () => {
      const flow = makeProofFlow();
      const redis = createMockRedis();
      redis.get.mockResolvedValue(JSON.stringify(flow));

      const result = await getFlow(MOCK_FLOW_ID, redis as unknown as SkillDeps['redis']);

      expect(result).not.toBeNull();
      expect(result!.flowId).toBe(MOCK_FLOW_ID);
      expect(result!.phase).toBe('signing');
      expect(result!.requestId).toBe(MOCK_REQUEST_ID);
    });

    it('returns null when flow not found', async () => {
      const redis = createMockRedis();
      redis.get.mockResolvedValue(null);

      const result = await getFlow('nonexistent-id', redis as unknown as SkillDeps['redis']);

      expect(result).toBeNull();
    });

    it('looks up the correct Redis key flow:{flowId}', async () => {
      const redis = createMockRedis();
      redis.get.mockResolvedValue(null);

      await getFlow('test-flow-id', redis as unknown as SkillDeps['redis']);

      expect(redis.get).toHaveBeenCalledWith('flow:test-flow-id');
    });

    it('parses and returns the stored JSON correctly', async () => {
      const flow = makeProofFlow({
        phase: 'payment',
        paymentUrl: 'https://ai.zkproofport.app/pay/req-abc-123',
      });
      const redis = createMockRedis();
      redis.get.mockResolvedValue(JSON.stringify(flow));

      const result = await getFlow(MOCK_FLOW_ID, redis as unknown as SkillDeps['redis']);

      expect(result!.phase).toBe('payment');
      expect(result!.paymentUrl).toBe('https://ai.zkproofport.app/pay/req-abc-123');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getFlowByRequestId
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getFlowByRequestId', () => {
    it('resolves flowId from reverse lookup and returns ProofFlow', async () => {
      const flow = makeProofFlow();
      const redis = createMockRedis();
      // First call: reverse lookup → flowId
      // Second call: flow record → flow JSON
      redis.get
        .mockResolvedValueOnce(MOCK_FLOW_ID)
        .mockResolvedValueOnce(JSON.stringify(flow));

      const result = await getFlowByRequestId(MOCK_REQUEST_ID, redis as unknown as SkillDeps['redis']);

      expect(result).not.toBeNull();
      expect(result!.flowId).toBe(MOCK_FLOW_ID);
      expect(result!.requestId).toBe(MOCK_REQUEST_ID);
    });

    it('looks up correct reverse-lookup key flow:req:{requestId}', async () => {
      const redis = createMockRedis();
      redis.get.mockResolvedValue(null);

      await getFlowByRequestId('my-req-id', redis as unknown as SkillDeps['redis']);

      expect(redis.get).toHaveBeenCalledWith('flow:req:my-req-id');
    });

    it('returns null when requestId not found in reverse lookup', async () => {
      const redis = createMockRedis();
      redis.get.mockResolvedValue(null);

      const result = await getFlowByRequestId('unknown-req-id', redis as unknown as SkillDeps['redis']);

      expect(result).toBeNull();
    });

    it('returns null when reverse lookup exists but flow has been evicted', async () => {
      const redis = createMockRedis();
      // Reverse lookup returns flowId, but the flow itself is gone
      redis.get
        .mockResolvedValueOnce(MOCK_FLOW_ID)
        .mockResolvedValueOnce(null);

      const result = await getFlowByRequestId(MOCK_REQUEST_ID, redis as unknown as SkillDeps['redis']);

      expect(result).toBeNull();
    });

    it('looks up flow:req:{requestId} then flow:{flowId} in correct order', async () => {
      const flow = makeProofFlow();
      const redis = createMockRedis();
      redis.get
        .mockResolvedValueOnce(MOCK_FLOW_ID)
        .mockResolvedValueOnce(JSON.stringify(flow));

      await getFlowByRequestId(MOCK_REQUEST_ID, redis as unknown as SkillDeps['redis']);

      const calls = redis.get.mock.calls;
      expect(calls[0][0]).toBe(`flow:req:${MOCK_REQUEST_ID}`);
      expect(calls[1][0]).toBe(`flow:${MOCK_FLOW_ID}`);
    });
  });
});
