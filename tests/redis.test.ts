import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock ioredis
vi.mock('ioredis', () => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    del: vi.fn(),
    quit: vi.fn(),
    status: 'ready',
  };
  return { default: vi.fn(() => mockRedis), Redis: vi.fn(() => mockRedis) };
});

import { createRedisClient, type RedisClient } from '../src/redis/client.js';
import { RateLimiter } from '../src/redis/rateLimiter.js';
import { ProofCache } from '../src/redis/proofCache.js';

// ─── Redis Client ──────────────────────────────────────────────────────────

describe('RedisClient', () => {
  it('should create a Redis client with the given URL', () => {
    const client = createRedisClient('redis://localhost:6379');
    expect(client).toBeDefined();
    expect(client.get).toBeDefined();
    expect(client.set).toBeDefined();
  });
});

// ─── Rate Limiter ──────────────────────────────────────────────────────────

describe('RateLimiter', () => {
  let mockRedis: RedisClient;
  let limiter: RateLimiter;

  beforeEach(() => {
    mockRedis = createRedisClient('redis://localhost:6379');
    vi.clearAllMocks();
    limiter = new RateLimiter(mockRedis, {
      maxRequests: 10,
      windowSeconds: 60,
      keyPrefix: 'rl:prove',
    });
  });

  it('should allow requests under the limit', async () => {
    (mockRedis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (mockRedis.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (mockRedis.ttl as ReturnType<typeof vi.fn>).mockResolvedValue(60);

    const result = await limiter.check('user-123');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.limit).toBe(10);
  });

  it('should block requests at the limit', async () => {
    (mockRedis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(11);
    (mockRedis.ttl as ReturnType<typeof vi.fn>).mockResolvedValue(45);

    const result = await limiter.check('user-123');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBe(45);
  });

  it('should set TTL on first request (count=1)', async () => {
    (mockRedis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (mockRedis.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (mockRedis.ttl as ReturnType<typeof vi.fn>).mockResolvedValue(60);

    await limiter.check('user-new');
    expect(mockRedis.expire).toHaveBeenCalledWith('rl:prove:user-new', 60);
  });

  it('should NOT reset TTL on subsequent requests', async () => {
    (mockRedis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    (mockRedis.ttl as ReturnType<typeof vi.fn>).mockResolvedValue(30);

    await limiter.check('user-existing');
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it('should use correct key format', async () => {
    (mockRedis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (mockRedis.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (mockRedis.ttl as ReturnType<typeof vi.fn>).mockResolvedValue(60);

    await limiter.check('0xabc123');
    expect(mockRedis.incr).toHaveBeenCalledWith('rl:prove:0xabc123');
  });

  it('should handle exact limit (count = maxRequests)', async () => {
    (mockRedis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(10);
    (mockRedis.ttl as ReturnType<typeof vi.fn>).mockResolvedValue(20);

    const result = await limiter.check('user-123');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });
});

// ─── Proof Cache ───────────────────────────────────────────────────────────

describe('ProofCache', () => {
  let mockRedis: RedisClient;
  let cache: ProofCache;

  beforeEach(() => {
    mockRedis = createRedisClient('redis://localhost:6379');
    vi.clearAllMocks();
    cache = new ProofCache(mockRedis, { ttlSeconds: 3600 });
  });

  it('should return null for cache miss', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await cache.get('coinbase_attestation', {
      address: '0xabc',
      scope: 'test',
    });
    expect(result).toBeNull();
  });

  it('should return cached proof on hit', async () => {
    const cachedProof = {
      proof: '0xproof123',
      publicInputs: '0xpublic456',
      nullifier: '0xnull789',
      signalHash: '0xsig000',
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify(cachedProof),
    );

    const result = await cache.get('coinbase_attestation', {
      address: '0xabc',
      scope: 'test',
    });
    expect(result).toEqual(cachedProof);
  });

  it('should store proof with TTL', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const proofResult = {
      proof: '0xproof',
      publicInputs: '0xpublic',
      nullifier: '0xnull',
      signalHash: '0xsig',
    };

    await cache.set('coinbase_attestation', { address: '0xabc', scope: 'test' }, proofResult);

    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('proof:'),
      JSON.stringify(proofResult),
      'EX',
      3600,
    );
  });

  it('should generate deterministic cache keys for same inputs', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await cache.get('coinbase_attestation', { address: '0xabc', scope: 'test' });
    const call1Key = (mockRedis.get as ReturnType<typeof vi.fn>).mock.calls[0][0];

    await cache.get('coinbase_attestation', { address: '0xabc', scope: 'test' });
    const call2Key = (mockRedis.get as ReturnType<typeof vi.fn>).mock.calls[1][0];

    expect(call1Key).toBe(call2Key);
  });

  it('should generate different keys for different inputs', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await cache.get('coinbase_attestation', { address: '0xabc', scope: 'test' });
    const key1 = (mockRedis.get as ReturnType<typeof vi.fn>).mock.calls[0][0];

    await cache.get('coinbase_attestation', { address: '0xdef', scope: 'test' });
    const key2 = (mockRedis.get as ReturnType<typeof vi.fn>).mock.calls[1][0];

    expect(key1).not.toBe(key2);
  });

  it('should generate different keys for different circuits', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await cache.get('coinbase_attestation', { address: '0xabc', scope: 'test' });
    const key1 = (mockRedis.get as ReturnType<typeof vi.fn>).mock.calls[0][0];

    await cache.get('coinbase_country_attestation', { address: '0xabc', scope: 'test' });
    const key2 = (mockRedis.get as ReturnType<typeof vi.fn>).mock.calls[1][0];

    expect(key1).not.toBe(key2);
  });

  it('should include country fields in cache key for country attestation', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await cache.get('coinbase_country_attestation', {
      address: '0xabc',
      scope: 'test',
      countryList: ['US', 'KR'],
      isIncluded: true,
    });
    const key1 = (mockRedis.get as ReturnType<typeof vi.fn>).mock.calls[0][0];

    await cache.get('coinbase_country_attestation', {
      address: '0xabc',
      scope: 'test',
      countryList: ['US', 'KR'],
      isIncluded: false,
    });
    const key2 = (mockRedis.get as ReturnType<typeof vi.fn>).mock.calls[1][0];

    expect(key1).not.toBe(key2);
  });

  it('should invalidate (delete) a cached proof', async () => {
    (mockRedis.del as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    await cache.invalidate('coinbase_attestation', { address: '0xabc', scope: 'test' });
    expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining('proof:'));
  });
});
