import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock variables (available inside vi.mock factories) ──────────────

const {
  MOCK_UUID,
  MOCK_PROOF_ID,
  mockVerifyFn,
  mockContractCtor,
  mockJsonRpcProviderCtor,
  mockBbProve,
  mockComputeCircuitParams,
  mockStoreProofResult,
} = vi.hoisted(() => {
  const mockVerifyFn = vi.fn();
  const mockContractCtor = vi.fn().mockImplementation(() => ({
    verify: mockVerifyFn,
  }));
  const mockJsonRpcProviderCtor = vi.fn().mockImplementation(() => ({}));
  const mockBbProve = vi.fn();
  const mockComputeCircuitParams = vi.fn();
  const MOCK_PROOF_ID = 'proof-id-1234';
  const mockStoreProofResult = vi.fn().mockResolvedValue(MOCK_PROOF_ID);

  return {
    MOCK_UUID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    MOCK_PROOF_ID,
    mockVerifyFn,
    mockContractCtor,
    mockJsonRpcProviderCtor,
    mockBbProve,
    mockComputeCircuitParams,
    mockStoreProofResult,
  };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => MOCK_UUID),
}));

vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: mockJsonRpcProviderCtor,
    Contract: mockContractCtor,
    hexlify: vi.fn((bytes: Uint8Array) => '0x' + Buffer.from(bytes).toString('hex')),
    keccak256: vi.fn(() => '0xfakekeccak256hash'),
    getBytes: vi.fn((hex: string) => Buffer.from(hex.replace('0x', ''), 'hex')),
  },
}));

vi.mock('../src/prover/bbProver.js', () => ({
  BbProver: vi.fn().mockImplementation(() => ({
    prove: mockBbProve,
  })),
}));

vi.mock('../src/input/inputBuilder.js', () => ({
  computeCircuitParams: (...args: unknown[]) => mockComputeCircuitParams(...args),
}));

vi.mock('../src/redis/proofResultStore.js', () => ({
  storeProofResult: (...args: unknown[]) => mockStoreProofResult(...args),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  handleRequestSigning,
  handleCheckStatus,
  handleRequestPayment,
  handleGenerateProof,
  handleVerifyProof,
  handleGetSupportedCircuits,
  type SkillDeps,
} from '../src/skills/skillHandler.js';
import { CIRCUITS } from '../src/config/circuits.js';
import { VERIFIER_ADDRESSES } from '../src/config/contracts.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createMockRedis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(300),
    // Additional ioredis methods that may be referenced
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

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-123',
    scope: 'my-dapp',
    circuitId: 'coinbase_attestation',
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('skillHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock for storeProofResult
    mockStoreProofResult.mockResolvedValue(MOCK_PROOF_ID);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Skill 1: handleRequestSigning
  // ═══════════════════════════════════════════════════════════════════════════

  describe('handleRequestSigning', () => {
    it('should create a valid signing session for coinbase_attestation', async () => {
      const deps = createMockDeps();
      const result = await handleRequestSigning(
        { circuitId: 'coinbase_attestation', scope: 'my-dapp' },
        deps,
      );

      expect(result.requestId).toBe(MOCK_UUID);
      expect(result.circuitId).toBe('coinbase_attestation');
      expect(result.scope).toBe('my-dapp');
      expect(result.signingUrl).toBe(`https://ai.zkproofport.app/s/${MOCK_UUID}`);
      expect(result.expiresAt).toBeDefined();
      // Verify ISO timestamp
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('should create a valid signing session for coinbase_country_attestation', async () => {
      const deps = createMockDeps();
      const result = await handleRequestSigning(
        {
          circuitId: 'coinbase_country_attestation',
          scope: 'country-check',
          countryList: ['US', 'CA'],
          isIncluded: true,
        },
        deps,
      );

      expect(result.requestId).toBe(MOCK_UUID);
      expect(result.circuitId).toBe('coinbase_country_attestation');
      expect(result.scope).toBe('country-check');
    });

    it('should store record in Redis with correct key pattern and TTL', async () => {
      const deps = createMockDeps();
      await handleRequestSigning(
        { circuitId: 'coinbase_attestation', scope: 'test' },
        deps,
      );

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, value, exFlag, ttl] = redis.set.mock.calls[0];
      expect(key).toBe(`signing:${MOCK_UUID}`);
      expect(exFlag).toBe('EX');
      expect(ttl).toBe(300);

      // Verify record structure
      const stored = JSON.parse(value);
      expect(stored.id).toBe(MOCK_UUID);
      expect(stored.scope).toBe('test');
      expect(stored.circuitId).toBe('coinbase_attestation');
      expect(stored.status).toBe('pending');
    });

    it('should store countryList and isIncluded in the record for country circuit', async () => {
      const deps = createMockDeps();
      await handleRequestSigning(
        {
          circuitId: 'coinbase_country_attestation',
          scope: 'test',
          countryList: ['US', 'GB'],
          isIncluded: false,
        },
        deps,
      );

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      const stored = JSON.parse(redis.set.mock.calls[0][1]);
      expect(stored.countryList).toEqual(['US', 'GB']);
      expect(stored.isIncluded).toBe(false);
    });

    it('should format signingUrl correctly with trailing slash in signPageUrl', async () => {
      const deps = createMockDeps({ signPageUrl: 'https://ai.zkproofport.app/' });
      const result = await handleRequestSigning(
        { circuitId: 'coinbase_attestation', scope: 'test' },
        deps,
      );

      // Trailing slash should be stripped before appending /s/
      expect(result.signingUrl).toBe(`https://ai.zkproofport.app/s/${MOCK_UUID}`);
    });

    it('should throw if circuitId is missing', async () => {
      const deps = createMockDeps();
      await expect(
        handleRequestSigning({ circuitId: '', scope: 'test' }, deps),
      ).rejects.toThrow('circuitId is required');
    });

    it('should throw if circuitId is unknown with list of supported circuits', async () => {
      const deps = createMockDeps();
      await expect(
        handleRequestSigning({ circuitId: 'nonexistent_circuit', scope: 'test' }, deps),
      ).rejects.toThrow('Unknown circuit: "nonexistent_circuit"');
      await expect(
        handleRequestSigning({ circuitId: 'nonexistent_circuit', scope: 'test' }, deps),
      ).rejects.toThrow('Supported circuits:');
    });

    it('should throw if scope is empty', async () => {
      const deps = createMockDeps();
      await expect(
        handleRequestSigning({ circuitId: 'coinbase_attestation', scope: '' }, deps),
      ).rejects.toThrow('scope is required');
    });

    it('should throw if scope is whitespace-only', async () => {
      const deps = createMockDeps();
      await expect(
        handleRequestSigning({ circuitId: 'coinbase_attestation', scope: '   ' }, deps),
      ).rejects.toThrow('scope is required');
    });

    it('should throw if coinbase_country_attestation is missing countryList', async () => {
      const deps = createMockDeps();
      await expect(
        handleRequestSigning(
          { circuitId: 'coinbase_country_attestation', scope: 'test', isIncluded: true },
          deps,
        ),
      ).rejects.toThrow('countryList is required for coinbase_country_attestation');
    });

    it('should throw if coinbase_country_attestation has empty countryList', async () => {
      const deps = createMockDeps();
      await expect(
        handleRequestSigning(
          { circuitId: 'coinbase_country_attestation', scope: 'test', countryList: [], isIncluded: true },
          deps,
        ),
      ).rejects.toThrow('countryList is required for coinbase_country_attestation');
    });

    it('should throw if coinbase_country_attestation is missing isIncluded', async () => {
      const deps = createMockDeps();
      await expect(
        handleRequestSigning(
          { circuitId: 'coinbase_country_attestation', scope: 'test', countryList: ['US'] },
          deps,
        ),
      ).rejects.toThrow('isIncluded is required for coinbase_country_attestation');
    });

    it('should throw if signPageUrl is not configured', async () => {
      const deps = createMockDeps({ signPageUrl: '' });
      await expect(
        handleRequestSigning({ circuitId: 'coinbase_attestation', scope: 'test' }, deps),
      ).rejects.toThrow('Web signing not configured');
    });

    it('should not include countryList/isIncluded in record for non-country circuit', async () => {
      const deps = createMockDeps();
      await handleRequestSigning(
        { circuitId: 'coinbase_attestation', scope: 'test' },
        deps,
      );

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      const stored = JSON.parse(redis.set.mock.calls[0][1]);
      expect(stored.countryList).toBeUndefined();
      expect(stored.isIncluded).toBeUndefined();
    });

    it('should set expiresAt based on signingTtlSeconds', async () => {
      const deps = createMockDeps({ signingTtlSeconds: 600 });
      const before = Date.now();
      const result = await handleRequestSigning(
        { circuitId: 'coinbase_attestation', scope: 'test' },
        deps,
      );
      const after = Date.now();

      const expiresMs = new Date(result.expiresAt).getTime();
      // Should be approximately now + 600s
      expect(expiresMs).toBeGreaterThanOrEqual(before + 600_000);
      expect(expiresMs).toBeLessThanOrEqual(after + 600_000);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Skill 2: handleCheckStatus
  // ═══════════════════════════════════════════════════════════════════════════

  describe('handleCheckStatus', () => {
    it('should throw if requestId is empty', async () => {
      const deps = createMockDeps();
      await expect(
        handleCheckStatus({ requestId: '' }, deps),
      ).rejects.toThrow('requestId is required');
    });

    it('should throw if requestId is whitespace-only', async () => {
      const deps = createMockDeps();
      await expect(
        handleCheckStatus({ requestId: '   ' }, deps),
      ).rejects.toThrow('requestId is required');
    });

    it('should throw if request is not found in Redis', async () => {
      const deps = createMockDeps();
      await expect(
        handleCheckStatus({ requestId: 'unknown-id' }, deps),
      ).rejects.toThrow('Request not found or expired');
    });

    it('should return phase: signing when status is pending', async () => {
      const record = makeRecord({ status: 'pending' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.phase).toBe('signing');
      expect(result.signing.status).toBe('pending');
      expect(result.signing.address).toBeUndefined();
    });

    it('should return phase: ready when signing completed and payment disabled', async () => {
      const record = makeRecord({
        status: 'completed',
        address: '0xabc',
      });
      const deps = createMockDeps({ paymentMode: 'disabled' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.phase).toBe('ready');
      expect(result.signing.status).toBe('completed');
      expect(result.signing.address).toBe('0xabc');
      expect(result.payment.status).toBe('not_required');
    });

    it('should return phase: payment when signing completed, payment enabled, payment pending', async () => {
      const record = makeRecord({
        status: 'completed',
        address: '0xabc',
        paymentStatus: 'pending',
      });
      const deps = createMockDeps({ paymentMode: 'testnet' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.phase).toBe('payment');
      expect(result.payment.status).toBe('pending');
      expect(result.payment.paymentUrl).toBe('https://ai.zkproofport.app/pay/req-123');
    });

    it('should return phase: payment when signing completed, payment enabled, no paymentStatus set', async () => {
      const record = makeRecord({
        status: 'completed',
        address: '0xabc',
        // paymentStatus not set at all
      });
      const deps = createMockDeps({ paymentMode: 'mainnet' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.phase).toBe('payment');
      expect(result.payment.status).toBe('pending');
      expect(result.payment.paymentUrl).toContain('/pay/req-123');
    });

    it('should return phase: ready when signing completed, payment enabled, payment completed', async () => {
      const record = makeRecord({
        status: 'completed',
        address: '0xabc',
        paymentStatus: 'completed',
        paymentTxHash: '0xtxhash123',
      });
      const deps = createMockDeps({ paymentMode: 'testnet' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.phase).toBe('ready');
      expect(result.payment.status).toBe('completed');
      expect(result.payment.txHash).toBe('0xtxhash123');
    });

    it('should return phase: expired when expiresAt is in the past', async () => {
      const record = makeRecord({
        status: 'pending',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.phase).toBe('expired');
      expect(result.signing.status).toBe('pending');
    });

    it('should return expired with signing completed when record was completed but expired', async () => {
      const record = makeRecord({
        status: 'completed',
        address: '0xabc',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.phase).toBe('expired');
      expect(result.signing.status).toBe('completed');
    });

    it('should include expiresAt in result', async () => {
      const expiresAt = new Date(Date.now() + 120_000).toISOString();
      const record = makeRecord({ status: 'pending', expiresAt });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.expiresAt).toBe(expiresAt);
    });

    it('should include paymentReceiptUrl when payment is completed (testnet)', async () => {
      const record = makeRecord({
        status: 'completed',
        address: '0xabc',
        paymentStatus: 'completed',
        paymentTxHash: '0xtxhash123',
      });
      const deps = createMockDeps({ paymentMode: 'testnet' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.payment.paymentReceiptUrl).toBe('https://sepolia.basescan.org/tx/0xtxhash123');
    });

    it('should include paymentReceiptUrl with mainnet basescan URL', async () => {
      const record = makeRecord({
        status: 'completed',
        address: '0xabc',
        paymentStatus: 'completed',
        paymentTxHash: '0xtxhash456',
      });
      const deps = createMockDeps({ paymentMode: 'mainnet' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.payment.paymentReceiptUrl).toBe('https://basescan.org/tx/0xtxhash456');
    });

    it('should not include paymentReceiptUrl when payment has no txHash', async () => {
      const record = makeRecord({
        status: 'completed',
        address: '0xabc',
        paymentStatus: 'completed',
        // no paymentTxHash
      });
      const deps = createMockDeps({ paymentMode: 'testnet' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.payment.paymentReceiptUrl).toBeUndefined();
    });

    it('should include verifier info when phase is ready', async () => {
      const record = makeRecord({
        status: 'completed',
        address: '0xabc',
      });
      const deps = createMockDeps({ paymentMode: 'disabled' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.phase).toBe('ready');
      expect(result.circuitId).toBe('coinbase_attestation');
      expect(result.verifierAddress).toBeDefined();
      expect(result.verifierExplorerUrl).toBe(
        `https://sepolia.basescan.org/address/${result.verifierAddress}`
      );
    });

    it('should not include verifier info when phase is not ready', async () => {
      const record = makeRecord({ status: 'pending' });
      const deps = createMockDeps();
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleCheckStatus({ requestId: 'req-123' }, deps);

      expect(result.phase).toBe('signing');
      expect(result.circuitId).toBeUndefined();
      expect(result.verifierAddress).toBeUndefined();
      expect(result.verifierExplorerUrl).toBeUndefined();
    });

    it('should look up the correct Redis key', async () => {
      const deps = createMockDeps();
      await handleCheckStatus({ requestId: 'my-req-id' }, deps).catch(() => {});

      expect(deps.redis.get).toHaveBeenCalledWith('signing:my-req-id');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Skill 3: handleRequestPayment
  // ═══════════════════════════════════════════════════════════════════════════

  describe('handleRequestPayment', () => {
    it('should throw if requestId is empty', async () => {
      const deps = createMockDeps({ paymentMode: 'testnet' });
      await expect(
        handleRequestPayment({ requestId: '' }, deps),
      ).rejects.toThrow('requestId is required');
    });

    it('should throw if request is not found in Redis', async () => {
      const deps = createMockDeps({ paymentMode: 'testnet' });
      await expect(
        handleRequestPayment({ requestId: 'not-found' }, deps),
      ).rejects.toThrow('Request not found or expired');
    });

    it('should throw if payment mode is disabled', async () => {
      const record = makeRecord({ status: 'completed', address: '0xabc' });
      const deps = createMockDeps({ paymentMode: 'disabled' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      await expect(
        handleRequestPayment({ requestId: 'req-123' }, deps),
      ).rejects.toThrow('Payment is not required');
    });

    it('should throw if signing is not completed', async () => {
      const record = makeRecord({ status: 'pending' });
      const deps = createMockDeps({ paymentMode: 'testnet' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      await expect(
        handleRequestPayment({ requestId: 'req-123' }, deps),
      ).rejects.toThrow('Signing must be completed before requesting payment');
    });

    it('should throw if payment is already completed', async () => {
      const record = makeRecord({
        status: 'completed',
        address: '0xabc',
        paymentStatus: 'completed',
        paymentTxHash: '0xtx',
      });
      const deps = createMockDeps({ paymentMode: 'testnet' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      await expect(
        handleRequestPayment({ requestId: 'req-123' }, deps),
      ).rejects.toThrow('Payment already completed');
    });

    it('should return payment URL, amount, currency, and network for testnet', async () => {
      const record = makeRecord({ status: 'completed', address: '0xabc' });
      const deps = createMockDeps({ paymentMode: 'testnet', paymentProofPrice: '$0.10' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleRequestPayment({ requestId: 'req-123' }, deps);

      expect(result.requestId).toBe('req-123');
      expect(result.paymentUrl).toBe('https://ai.zkproofport.app/pay/req-123');
      expect(result.amount).toBe('$0.10');
      expect(result.currency).toBe('USDC');
      expect(result.network).toBe('Base Sepolia');
    });

    it('should return network "Base" for mainnet mode', async () => {
      const record = makeRecord({ status: 'completed', address: '0xabc' });
      const deps = createMockDeps({ paymentMode: 'mainnet' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      const result = await handleRequestPayment({ requestId: 'req-123' }, deps);

      expect(result.network).toBe('Base');
    });

    it('should set paymentStatus to pending on first call', async () => {
      const record = makeRecord({ status: 'completed', address: '0xabc' });
      const deps = createMockDeps({ paymentMode: 'testnet' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));
      (deps.redis.ttl as ReturnType<typeof vi.fn>).mockResolvedValue(250);

      await handleRequestPayment({ requestId: 'req-123' }, deps);

      // Should have called redis.set to update the record with paymentStatus: pending
      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      expect(redis.set).toHaveBeenCalledTimes(1);
      const savedRecord = JSON.parse(redis.set.mock.calls[0][1]);
      expect(savedRecord.paymentStatus).toBe('pending');
    });

    it('should use remaining TTL when updating record', async () => {
      const record = makeRecord({ status: 'completed', address: '0xabc' });
      const deps = createMockDeps({ paymentMode: 'testnet' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));
      (deps.redis.ttl as ReturnType<typeof vi.fn>).mockResolvedValue(180);

      await handleRequestPayment({ requestId: 'req-123' }, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      // TTL should use the remaining TTL from redis
      expect(redis.set.mock.calls[0][3]).toBe(180);
    });

    it('should not re-set paymentStatus if already pending', async () => {
      const record = makeRecord({ status: 'completed', address: '0xabc', paymentStatus: 'pending' });
      const deps = createMockDeps({ paymentMode: 'testnet' });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

      await handleRequestPayment({ requestId: 'req-123' }, deps);

      // Should NOT call set because paymentStatus is already set
      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('should fall back to signingTtlSeconds when TTL is expired', async () => {
      const record = makeRecord({ status: 'completed', address: '0xabc' });
      const deps = createMockDeps({ paymentMode: 'testnet', signingTtlSeconds: 300 });
      (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));
      (deps.redis.ttl as ReturnType<typeof vi.fn>).mockResolvedValue(-1);

      await handleRequestPayment({ requestId: 'req-123' }, deps);

      const redis = deps.redis as unknown as ReturnType<typeof createMockRedis>;
      expect(redis.set.mock.calls[0][3]).toBe(300);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Skill 4: handleGenerateProof
  // ═══════════════════════════════════════════════════════════════════════════

  describe('handleGenerateProof', () => {
    const mockCircuitParams = {
      signalHash: new Uint8Array([1, 2, 3, 4]),
      nullifierBytes: new Uint8Array([5, 6, 7, 8]),
      merkleRoot: '0xroot',
      scopeBytes: new Uint8Array([9, 10]),
      userAddress: '0xaddr',
      userSignature: '0xsig',
      userPubkeyX: '0xpx',
      userPubkeyY: '0xpy',
      rawTxBytes: [0, 1, 2],
      txLength: 3,
      attesterPubkeyX: '0xax',
      attesterPubkeyY: '0xay',
      merkleProof: ['0x1', '0x2'],
      merkleLeafIndex: 0,
      merkleDepth: 2,
    };

    const mockProofResult = {
      proof: '0xproofdata',
      publicInputs: '0xpublicinputs',
      proofWithInputs: '0xproofdatapublicinputs',
    };

    beforeEach(() => {
      mockComputeCircuitParams.mockResolvedValue(mockCircuitParams);
      mockBbProve.mockResolvedValue(mockProofResult);
    });

    // ── Mode A: Session flow ──────────────────────────────────────────────

    describe('Mode A: session flow (requestId)', () => {
      it('should generate proof from completed session record', async () => {
        const record = makeRecord({
          status: 'completed',
          address: '0xUserAddr',
          signature: '0xUserSig',
        });
        const deps = createMockDeps();
        (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

        const result = await handleGenerateProof({ requestId: 'req-123' }, deps);

        expect(result.proof).toBe('0xproofdata');
        expect(result.publicInputs).toBe('0xpublicinputs');
        expect(result.nullifier).toBeDefined();
        expect(result.signalHash).toBeDefined();
        expect(result.proofId).toBe(MOCK_PROOF_ID);
        expect(result.verifyUrl).toBe(`https://ai.zkproofport.app/v/${MOCK_PROOF_ID}`);
      });

      it('should throw if requestId is not found in Redis', async () => {
        const deps = createMockDeps();
        await expect(
          handleGenerateProof({ requestId: 'not-found' }, deps),
        ).rejects.toThrow('Request not found or expired');
      });

      it('should throw if signing is not completed', async () => {
        const record = makeRecord({ status: 'pending' });
        const deps = createMockDeps();
        (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

        await expect(
          handleGenerateProof({ requestId: 'req-123' }, deps),
        ).rejects.toThrow('Signing not yet completed');
      });

      it('should throw if payment is required but not completed', async () => {
        const record = makeRecord({
          status: 'completed',
          address: '0xabc',
          signature: '0xsig',
          paymentStatus: 'pending',
        });
        const deps = createMockDeps({ paymentMode: 'testnet' });
        (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

        await expect(
          handleGenerateProof({ requestId: 'req-123' }, deps),
        ).rejects.toThrow('Payment not yet completed');
      });

      it('should not check payment when payment mode is disabled', async () => {
        const record = makeRecord({
          status: 'completed',
          address: '0xabc',
          signature: '0xsig',
          // no paymentStatus
        });
        const deps = createMockDeps({ paymentMode: 'disabled' });
        (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

        // Should not throw about payment
        const result = await handleGenerateProof({ requestId: 'req-123' }, deps);
        expect(result.proof).toBe('0xproofdata');
      });

      it('should throw if address is missing in record', async () => {
        const record = makeRecord({
          status: 'completed',
          signature: '0xsig',
          // no address
        });
        const deps = createMockDeps();
        (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

        await expect(
          handleGenerateProof({ requestId: 'req-123' }, deps),
        ).rejects.toThrow('Signing record is missing address');
      });

      it('should throw if signature is missing in record', async () => {
        const record = makeRecord({
          status: 'completed',
          address: '0xabc',
          // no signature
        });
        const deps = createMockDeps();
        (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

        await expect(
          handleGenerateProof({ requestId: 'req-123' }, deps),
        ).rejects.toThrow('Signing record is missing signature');
      });

      it('should consume the signing record (delete from Redis)', async () => {
        const record = makeRecord({
          status: 'completed',
          address: '0xabc',
          signature: '0xsig',
        });
        const deps = createMockDeps();
        (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

        await handleGenerateProof({ requestId: 'req-123' }, deps);

        expect(deps.redis.del).toHaveBeenCalledWith('signing:req-123');
      });

      it('should include paymentTxHash in result when present', async () => {
        const record = makeRecord({
          status: 'completed',
          address: '0xabc',
          signature: '0xsig',
          paymentStatus: 'completed',
          paymentTxHash: '0xtxhash999',
        });
        const deps = createMockDeps({ paymentMode: 'testnet' });
        (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

        const result = await handleGenerateProof({ requestId: 'req-123' }, deps);

        expect(result.paymentTxHash).toBe('0xtxhash999');
      });

      it('should include paymentReceiptUrl when paymentTxHash is present (testnet)', async () => {
        const record = makeRecord({
          status: 'completed',
          address: '0xabc',
          signature: '0xsig',
          paymentStatus: 'completed',
          paymentTxHash: '0xtxhash999',
        });
        const deps = createMockDeps({ paymentMode: 'testnet' });
        (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

        const result = await handleGenerateProof({ requestId: 'req-123' }, deps);

        expect(result.paymentReceiptUrl).toBe('https://sepolia.basescan.org/tx/0xtxhash999');
      });

      it('should include paymentReceiptUrl with mainnet URL when paymentMode is mainnet', async () => {
        const record = makeRecord({
          status: 'completed',
          address: '0xabc',
          signature: '0xsig',
          paymentStatus: 'completed',
          paymentTxHash: '0xtxhash999',
        });
        const deps = createMockDeps({ paymentMode: 'mainnet' });
        (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

        const result = await handleGenerateProof({ requestId: 'req-123' }, deps);

        expect(result.paymentReceiptUrl).toBe('https://basescan.org/tx/0xtxhash999');
      });

      it('should not include paymentReceiptUrl when no paymentTxHash', async () => {
        const record = makeRecord({
          status: 'completed',
          address: '0xabc',
          signature: '0xsig',
        });
        const deps = createMockDeps({ paymentMode: 'disabled' });
        (deps.redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

        const result = await handleGenerateProof({ requestId: 'req-123' }, deps);

        expect(result.paymentReceiptUrl).toBeUndefined();
        expect(result.paymentTxHash).toBeUndefined();
      });
    });

    // ── Mode B: Direct flow ───────────────────────────────────────────────

    describe('Mode B: direct flow (address + signature)', () => {
      it('should generate proof with direct parameters', async () => {
        const deps = createMockDeps();

        const result = await handleGenerateProof(
          {
            address: '0xUserAddr',
            signature: '0xUserSig',
            scope: 'my-scope',
            circuitId: 'coinbase_attestation',
          },
          deps,
        );

        expect(result.proof).toBe('0xproofdata');
        expect(result.proofId).toBe(MOCK_PROOF_ID);
        // Should NOT have called redis.del (no session to consume)
        expect(deps.redis.del).not.toHaveBeenCalled();
      });

      it('should include verifierAddress and verifierExplorerUrl', async () => {
        const deps = createMockDeps();

        const result = await handleGenerateProof(
          {
            address: '0xUserAddr',
            signature: '0xUserSig',
            scope: 'my-scope',
            circuitId: 'coinbase_attestation',
          },
          deps,
        );

        expect(result.verifierAddress).toBeDefined();
        expect(result.verifierExplorerUrl).toBe(
          `https://sepolia.basescan.org/address/${result.verifierAddress}`
        );
      });

      it('should throw if address is missing in direct mode', async () => {
        const deps = createMockDeps();
        await expect(
          handleGenerateProof(
            { signature: '0xsig', scope: 'test', circuitId: 'coinbase_attestation' },
            deps,
          ),
        ).rejects.toThrow('Either provide requestId');
      });

      it('should throw if signature is missing in direct mode', async () => {
        const deps = createMockDeps();
        await expect(
          handleGenerateProof(
            { address: '0xabc', scope: 'test', circuitId: 'coinbase_attestation' },
            deps,
          ),
        ).rejects.toThrow('Either provide requestId');
      });

      it('should throw if scope is missing in direct mode', async () => {
        const deps = createMockDeps();
        await expect(
          handleGenerateProof(
            { address: '0xabc', signature: '0xsig', circuitId: 'coinbase_attestation' },
            deps,
          ),
        ).rejects.toThrow('scope is required for direct proof generation');
      });

      it('should throw if circuitId is missing in direct mode', async () => {
        const deps = createMockDeps();
        await expect(
          handleGenerateProof(
            { address: '0xabc', signature: '0xsig', scope: 'test' },
            deps,
          ),
        ).rejects.toThrow('circuitId is required for direct proof generation');
      });
    });

    // ── Shared validation ─────────────────────────────────────────────────

    describe('shared validation', () => {
      it('should throw for unknown circuitId', async () => {
        const deps = createMockDeps();
        await expect(
          handleGenerateProof(
            { address: '0xa', signature: '0xs', scope: 'test', circuitId: 'bad_circuit' },
            deps,
          ),
        ).rejects.toThrow('Unknown circuit: "bad_circuit"');
      });

      it('should throw for country circuit without countryList', async () => {
        const deps = createMockDeps();
        await expect(
          handleGenerateProof(
            {
              address: '0xa',
              signature: '0xs',
              scope: 'test',
              circuitId: 'coinbase_country_attestation',
              isIncluded: true,
            },
            deps,
          ),
        ).rejects.toThrow('countryList is required for coinbase_country_attestation');
      });

      it('should throw for country circuit without isIncluded', async () => {
        const deps = createMockDeps();
        await expect(
          handleGenerateProof(
            {
              address: '0xa',
              signature: '0xs',
              scope: 'test',
              circuitId: 'coinbase_country_attestation',
              countryList: ['US'],
            },
            deps,
          ),
        ).rejects.toThrow('isIncluded is required for coinbase_country_attestation');
      });
    });

    // ── Rate limiter ──────────────────────────────────────────────────────

    describe('rate limiter', () => {
      it('should throw when rate limiter blocks', async () => {
        const mockRateLimiter = {
          check: vi.fn().mockResolvedValue({ allowed: false, retryAfter: 30, remaining: 0, limit: 5 }),
        };
        const deps = createMockDeps({ rateLimiter: mockRateLimiter as unknown as SkillDeps['rateLimiter'] });

        await expect(
          handleGenerateProof(
            { address: '0xa', signature: '0xs', scope: 'test', circuitId: 'coinbase_attestation' },
            deps,
          ),
        ).rejects.toThrow('Rate limit exceeded. Retry after 30 seconds.');
      });

      it('should proceed when rate limiter allows', async () => {
        const mockRateLimiter = {
          check: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, limit: 5 }),
        };
        const deps = createMockDeps({ rateLimiter: mockRateLimiter as unknown as SkillDeps['rateLimiter'] });

        const result = await handleGenerateProof(
          { address: '0xa', signature: '0xs', scope: 'test', circuitId: 'coinbase_attestation' },
          deps,
        );

        expect(result.proof).toBe('0xproofdata');
        expect(mockRateLimiter.check).toHaveBeenCalledWith('0xa');
      });
    });

    // ── Cache ─────────────────────────────────────────────────────────────

    describe('proof cache', () => {
      it('should return cached result with cached: true', async () => {
        const cachedResult = {
          proof: '0xcachedproof',
          publicInputs: '0xcachedpubinputs',
          nullifier: '0xcachednullifier',
          signalHash: '0xcachedsignal',
        };
        const mockProofCache = {
          get: vi.fn().mockResolvedValue(cachedResult),
          set: vi.fn(),
        };
        const deps = createMockDeps({ proofCache: mockProofCache as unknown as SkillDeps['proofCache'] });

        const result = await handleGenerateProof(
          { address: '0xa', signature: '0xs', scope: 'test', circuitId: 'coinbase_attestation' },
          deps,
        );

        expect(result.proof).toBe('0xcachedproof');
        expect(result.cached).toBe(true);
        expect(result.proofId).toBe(MOCK_PROOF_ID);
        // Should NOT have called computeCircuitParams or bbProve
        expect(mockComputeCircuitParams).not.toHaveBeenCalled();
        expect(mockBbProve).not.toHaveBeenCalled();
      });

      it('should fall through to proving when cache misses', async () => {
        const mockProofCache = {
          get: vi.fn().mockResolvedValue(null),
          set: vi.fn(),
        };
        const deps = createMockDeps({ proofCache: mockProofCache as unknown as SkillDeps['proofCache'] });

        const result = await handleGenerateProof(
          { address: '0xa', signature: '0xs', scope: 'test', circuitId: 'coinbase_attestation' },
          deps,
        );

        expect(result.proof).toBe('0xproofdata');
        expect(result.cached).toBeUndefined();
        expect(mockComputeCircuitParams).toHaveBeenCalled();
      });

      it('should store result in cache after proving', async () => {
        const mockProofCache = {
          get: vi.fn().mockResolvedValue(null),
          set: vi.fn(),
        };
        const deps = createMockDeps({ proofCache: mockProofCache as unknown as SkillDeps['proofCache'] });

        await handleGenerateProof(
          { address: '0xa', signature: '0xs', scope: 'test', circuitId: 'coinbase_attestation' },
          deps,
        );

        expect(mockProofCache.set).toHaveBeenCalledWith(
          'coinbase_attestation',
          expect.objectContaining({ address: '0xa', scope: 'test' }),
          expect.objectContaining({ proof: '0xproofdata' }),
        );
      });
    });

    // ── TEE provider ──────────────────────────────────────────────────────

    describe('TEE provider', () => {
      it('should use TEE provider when teeMode is nitro', async () => {
        const mockTeeProvider = {
          mode: 'nitro' as const,
          prove: vi.fn().mockResolvedValue({
            type: 'proof',
            requestId: 'tee-req',
            proof: '0xteeproof',
            publicInputs: ['0xteepubinputs'],
          }),
          healthCheck: vi.fn(),
          getAttestation: vi.fn(),
          generateAttestation: vi.fn().mockResolvedValue(null),
        };
        const deps = createMockDeps({
          teeMode: 'nitro',
          teeProvider: mockTeeProvider as unknown as SkillDeps['teeProvider'],
        });

        const result = await handleGenerateProof(
          { address: '0xa', signature: '0xs', scope: 'test', circuitId: 'coinbase_attestation' },
          deps,
        );

        expect(result.proof).toBe('0xteeproof');
        expect(mockTeeProvider.prove).toHaveBeenCalledWith(
          'coinbase_attestation',
          expect.any(Array),
          expect.any(String),
        );
        // bb prover should NOT have been used
        expect(mockBbProve).not.toHaveBeenCalled();
      });

      it('should throw when TEE returns error type', async () => {
        const mockTeeProvider = {
          mode: 'nitro' as const,
          prove: vi.fn().mockResolvedValue({
            type: 'error',
            requestId: 'tee-req',
            error: 'Enclave out of memory',
          }),
          healthCheck: vi.fn(),
          getAttestation: vi.fn(),
          generateAttestation: vi.fn(),
        };
        const deps = createMockDeps({
          teeMode: 'nitro',
          teeProvider: mockTeeProvider as unknown as SkillDeps['teeProvider'],
        });

        await expect(
          handleGenerateProof(
            { address: '0xa', signature: '0xs', scope: 'test', circuitId: 'coinbase_attestation' },
            deps,
          ),
        ).rejects.toThrow('Enclave out of memory');
      });

      it('should use bb prover when teeMode is not nitro even if teeProvider exists', async () => {
        const mockTeeProvider = {
          mode: 'local' as const,
          prove: vi.fn(),
          healthCheck: vi.fn(),
          getAttestation: vi.fn(),
          generateAttestation: vi.fn().mockResolvedValue(null),
        };
        const deps = createMockDeps({
          teeMode: 'local',
          teeProvider: mockTeeProvider as unknown as SkillDeps['teeProvider'],
        });

        const result = await handleGenerateProof(
          { address: '0xa', signature: '0xs', scope: 'test', circuitId: 'coinbase_attestation' },
          deps,
        );

        expect(result.proof).toBe('0xproofdata');
        expect(mockTeeProvider.prove).not.toHaveBeenCalled();
      });
    });

    // ── Calls storeProofResult ────────────────────────────────────────────

    it('should store proof result in Redis via storeProofResult', async () => {
      const deps = createMockDeps();
      await handleGenerateProof(
        { address: '0xa', signature: '0xs', scope: 'test', circuitId: 'coinbase_attestation' },
        deps,
      );

      expect(mockStoreProofResult).toHaveBeenCalledWith(
        deps.redis,
        expect.objectContaining({
          proof: '0xproofdata',
          publicInputs: '0xpublicinputs',
          circuitId: 'coinbase_attestation',
        }),
      );
    });

    it('should pass correct args to computeCircuitParams', async () => {
      const deps = createMockDeps();
      await handleGenerateProof(
        {
          address: '0xAddr',
          signature: '0xSig',
          scope: 'scope1',
          circuitId: 'coinbase_attestation',
        },
        deps,
      );

      expect(mockComputeCircuitParams).toHaveBeenCalledWith(
        expect.objectContaining({
          address: '0xAddr',
          signature: '0xSig',
          scope: 'scope1',
          circuitId: 'coinbase_attestation',
        }),
        'https://base.easscan.org/graphql',
        ['https://sepolia.base.org'],
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Skill 5: handleVerifyProof
  // ═══════════════════════════════════════════════════════════════════════════

  describe('handleVerifyProof', () => {
    it('should throw if circuitId is missing', async () => {
      const deps = createMockDeps();
      await expect(
        handleVerifyProof({ circuitId: '', proof: '0x1', publicInputs: ['0x2'] }, deps),
      ).rejects.toThrow('circuitId is required');
    });

    it('should throw if proof is missing', async () => {
      const deps = createMockDeps();
      await expect(
        handleVerifyProof({ circuitId: 'coinbase_attestation', proof: '', publicInputs: ['0x2'] }, deps),
      ).rejects.toThrow('proof is required');
    });

    it('should throw if publicInputs is null', async () => {
      const deps = createMockDeps();
      await expect(
        handleVerifyProof(
          { circuitId: 'coinbase_attestation', proof: '0x1', publicInputs: null as unknown as string[] },
          deps,
        ),
      ).rejects.toThrow('publicInputs is required');
    });

    it('should throw if publicInputs is undefined', async () => {
      const deps = createMockDeps();
      await expect(
        handleVerifyProof(
          { circuitId: 'coinbase_attestation', proof: '0x1', publicInputs: undefined as unknown as string[] },
          deps,
        ),
      ).rejects.toThrow('publicInputs is required');
    });

    it('should throw for unknown circuitId', async () => {
      const deps = createMockDeps();
      await expect(
        handleVerifyProof(
          { circuitId: 'unknown_circuit', proof: '0x1', publicInputs: ['0x2'] },
          deps,
        ),
      ).rejects.toThrow('Unknown circuit: "unknown_circuit"');
    });

    it('should throw for unknown chainId with no verifier', async () => {
      const deps = createMockDeps();
      await expect(
        handleVerifyProof(
          { circuitId: 'coinbase_attestation', proof: '0x1', publicInputs: ['0x2'], chainId: '99999' },
          deps,
        ),
      ).rejects.toThrow('No verifier deployed for circuit "coinbase_attestation" on chain "99999"');
    });

    it('should return valid: true for successful on-chain verification', async () => {
      mockVerifyFn.mockResolvedValue(true);
      const deps = createMockDeps();

      const result = await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0xproof', publicInputs: ['0x1111'] },
        deps,
      );

      expect(result.valid).toBe(true);
      expect(result.circuitId).toBe('coinbase_attestation');
      expect(result.verifierAddress).toBe(VERIFIER_ADDRESSES['84532']['coinbase_attestation']);
      expect(result.chainId).toBe('84532');
      expect(result.error).toBeUndefined();
    });

    it('should include verifierExplorerUrl for Base Sepolia', async () => {
      mockVerifyFn.mockResolvedValue(true);
      const deps = createMockDeps();

      const result = await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0xproof', publicInputs: ['0x1111'] },
        deps,
      );

      expect(result.verifierExplorerUrl).toBe(
        `https://sepolia.basescan.org/address/${VERIFIER_ADDRESSES['84532']['coinbase_attestation']}`
      );
    });

    it('should include verifierExplorerUrl even on contract revert', async () => {
      mockVerifyFn.mockRejectedValue(new Error('execution reverted'));
      const deps = createMockDeps();

      const result = await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0xbad', publicInputs: ['0x1111'] },
        deps,
      );

      expect(result.valid).toBe(false);
      expect(result.verifierExplorerUrl).toBeDefined();
      expect(result.verifierExplorerUrl).toContain('sepolia.basescan.org/address/');
    });

    it('should return valid: false for failed on-chain verification', async () => {
      mockVerifyFn.mockResolvedValue(false);
      const deps = createMockDeps();

      const result = await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0xbad', publicInputs: ['0x1111'] },
        deps,
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it('should return valid: false with error message on contract revert', async () => {
      mockVerifyFn.mockRejectedValue(new Error('execution reverted'));
      const deps = createMockDeps();

      const result = await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0xbad', publicInputs: ['0x1111'] },
        deps,
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('execution reverted');
    });

    it('should default chainId to 84532', async () => {
      mockVerifyFn.mockResolvedValue(true);
      const deps = createMockDeps();

      const result = await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0x1', publicInputs: ['0x2'] },
        deps,
      );

      expect(result.chainId).toBe('84532');
    });

    it('should normalize publicInputs from string to array', async () => {
      mockVerifyFn.mockResolvedValue(true);
      const deps = createMockDeps();

      // Pass a hex string that should be split into 32-byte chunks
      const hexString = 'aa'.repeat(32) + 'bb'.repeat(32);
      await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0x1', publicInputs: hexString },
        deps,
      );

      // The contract verify should receive an array
      expect(mockVerifyFn).toHaveBeenCalledWith(
        '0x1',
        expect.arrayContaining([expect.stringMatching(/^0x/), expect.stringMatching(/^0x/)]),
      );
    });

    it('should use chainRpcUrl from deps', async () => {
      mockVerifyFn.mockResolvedValue(true);
      const deps = createMockDeps({ chainRpcUrl: 'https://custom-rpc.example.com' });

      await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0x1', publicInputs: ['0x2'] },
        deps,
      );

      expect(mockJsonRpcProviderCtor).toHaveBeenCalledWith('https://custom-rpc.example.com');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Skill 6: handleGetSupportedCircuits
  // ═══════════════════════════════════════════════════════════════════════════

  describe('handleGetSupportedCircuits', () => {
    it('should return all circuits with metadata', () => {
      const result = handleGetSupportedCircuits({});

      expect(result.circuits).toHaveLength(Object.keys(CIRCUITS).length);
      const ids = result.circuits.map(c => c.id);
      expect(ids).toContain('coinbase_attestation');
      expect(ids).toContain('coinbase_country_attestation');
    });

    it('should default chainId to 84532', () => {
      const result = handleGetSupportedCircuits({});
      expect(result.chainId).toBe('84532');
    });

    it('should accept custom chainId', () => {
      const result = handleGetSupportedCircuits({ chainId: '8453' });
      expect(result.chainId).toBe('8453');
    });

    it('should include verifier addresses for known chain', () => {
      const result = handleGetSupportedCircuits({ chainId: '84532' });

      const kycCircuit = result.circuits.find(c => c.id === 'coinbase_attestation');
      expect(kycCircuit).toBeDefined();
      expect(kycCircuit!.verifierAddress).toBe(VERIFIER_ADDRESSES['84532']['coinbase_attestation']);

      const countryCircuit = result.circuits.find(c => c.id === 'coinbase_country_attestation');
      expect(countryCircuit).toBeDefined();
      expect(countryCircuit!.verifierAddress).toBe(VERIFIER_ADDRESSES['84532']['coinbase_country_attestation']);
    });

    it('should not include verifier addresses for unknown chain', () => {
      const result = handleGetSupportedCircuits({ chainId: '99999' });

      result.circuits.forEach(circuit => {
        expect(circuit.verifierAddress).toBeUndefined();
      });
    });

    it('should include displayName, description, and requiredInputs for each circuit', () => {
      const result = handleGetSupportedCircuits({});

      result.circuits.forEach(circuit => {
        expect(circuit.displayName).toBeDefined();
        expect(circuit.displayName.length).toBeGreaterThan(0);
        expect(circuit.description).toBeDefined();
        expect(circuit.description.length).toBeGreaterThan(0);
        expect(circuit.requiredInputs).toBeDefined();
        expect(circuit.requiredInputs.length).toBeGreaterThan(0);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // normalizePublicInputs helper (tested indirectly via handleVerifyProof)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('normalizePublicInputs (via handleVerifyProof)', () => {
    beforeEach(() => {
      mockVerifyFn.mockResolvedValue(true);
    });

    it('should pass array input as-is to contract', async () => {
      const deps = createMockDeps();
      const inputs = ['0xaaaa', '0xbbbb'];

      await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0x1', publicInputs: inputs },
        deps,
      );

      expect(mockVerifyFn).toHaveBeenCalledWith('0x1', ['0xaaaa', '0xbbbb']);
    });

    it('should split hex string into 32-byte (64 char) chunks', async () => {
      const deps = createMockDeps();
      // 64 hex chars = 32 bytes (one chunk)
      const oneChunk = 'a'.repeat(64);

      await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0x1', publicInputs: oneChunk },
        deps,
      );

      expect(mockVerifyFn).toHaveBeenCalledWith('0x1', ['0x' + 'a'.repeat(64)]);
    });

    it('should handle 0x-prefixed hex string', async () => {
      const deps = createMockDeps();
      const hex = '0x' + 'b'.repeat(64);

      await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0x1', publicInputs: hex },
        deps,
      );

      expect(mockVerifyFn).toHaveBeenCalledWith('0x1', ['0x' + 'b'.repeat(64)]);
    });

    it('should handle empty string by passing empty array', async () => {
      const deps = createMockDeps();

      await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0x1', publicInputs: '' },
        deps,
      );

      expect(mockVerifyFn).toHaveBeenCalledWith('0x1', []);
    });

    it('should pad odd-length last chunk to 64 chars with trailing zeros', async () => {
      const deps = createMockDeps();
      // 80 hex chars = 64 + 16, last chunk should be padded to 64
      const hex = 'c'.repeat(64) + 'd'.repeat(16);

      await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0x1', publicInputs: hex },
        deps,
      );

      const calls = mockVerifyFn.mock.calls[0][1];
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe('0x' + 'c'.repeat(64));
      expect(calls[1]).toBe('0x' + 'd'.repeat(16) + '0'.repeat(48));
    });

    it('should handle multiple full 32-byte chunks', async () => {
      const deps = createMockDeps();
      const hex = 'a'.repeat(64) + 'b'.repeat(64) + 'c'.repeat(64);

      await handleVerifyProof(
        { circuitId: 'coinbase_attestation', proof: '0x1', publicInputs: hex },
        deps,
      );

      const calls = mockVerifyFn.mock.calls[0][1];
      expect(calls).toHaveLength(3);
      expect(calls[0]).toBe('0x' + 'a'.repeat(64));
      expect(calls[1]).toBe('0x' + 'b'.repeat(64));
      expect(calls[2]).toBe('0x' + 'c'.repeat(64));
    });
  });
});
