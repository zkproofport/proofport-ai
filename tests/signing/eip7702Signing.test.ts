import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Eip7702SigningProvider, storePreSignedSignature, getPoolSize, createBatchSigningHandler } from '../../src/signing/eip7702Signing';
import type { SigningRequest } from '../../src/signing/types';
import type { RedisClient } from '../../src/redis/client';
import type { Request, Response } from 'express';

// Mock Redis client
function createMockRedis(): RedisClient {
  return {
    get: vi.fn(),
    set: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    del: vi.fn(),
    quit: vi.fn(),
    status: 'ready',
  } as any;
}

describe('Eip7702SigningProvider', () => {
  let mockRedis: RedisClient;

  beforeEach(() => {
    mockRedis = createMockRedis();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('sets method to eip7702', () => {
      const provider = new Eip7702SigningProvider({ redis: mockRedis });
      expect(provider.method).toBe('eip7702');
    });

    it('accepts custom ttlSeconds', () => {
      const provider = new Eip7702SigningProvider({ redis: mockRedis, ttlSeconds: 3600 });
      expect(provider.method).toBe('eip7702');
    });
  });

  describe('sign', () => {
    const signRequest: SigningRequest = {
      address: '0x1234567890123456789012345678901234567890',
      signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      scope: 'test-scope',
      method: 'eip7702',
    };

    it('returns pre-signed signature from Redis pool', async () => {
      const expectedSignature = '0xsignature1234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234';
      const storedData = {
        signature: expectedSignature,
        address: signRequest.address,
        createdAt: new Date().toISOString(),
      };

      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(storedData));

      const provider = new Eip7702SigningProvider({ redis: mockRedis });
      const result = await provider.sign(signRequest);

      expect(result).toEqual({
        signature: expectedSignature,
        address: signRequest.address,
        method: 'eip7702',
      });

      expect(mockRedis.get).toHaveBeenCalledWith(
        `signing:pool:${signRequest.address}:${signRequest.signalHash}`
      );
    });

    it('throws when no pre-signed signature available', async () => {
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const provider = new Eip7702SigningProvider({ redis: mockRedis });

      await expect(provider.sign(signRequest)).rejects.toThrow(
        'No pre-signed signature available for this signalHash'
      );
    });

    it('throws when stored data is invalid JSON', async () => {
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue('invalid-json');

      const provider = new Eip7702SigningProvider({ redis: mockRedis });

      await expect(provider.sign(signRequest)).rejects.toThrow();
    });

    it('throws when stored address does not match request address', async () => {
      const storedData = {
        signature: '0xsig',
        address: '0x9999999999999999999999999999999999999999',
        createdAt: new Date().toISOString(),
      };

      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(storedData));

      const provider = new Eip7702SigningProvider({ redis: mockRedis });

      await expect(provider.sign(signRequest)).rejects.toThrow('Address mismatch');
    });
  });

  describe('isAvailable', () => {
    const testAddress = '0x1234567890123456789012345678901234567890';

    it('returns true when pool has signatures', async () => {
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue('5');

      const provider = new Eip7702SigningProvider({ redis: mockRedis });
      const result = await provider.isAvailable(testAddress);

      expect(result).toBe(true);
      expect(mockRedis.get).toHaveBeenCalledWith(`signing:pool:count:${testAddress}`);
    });

    it('returns false when pool is empty', async () => {
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue('0');

      const provider = new Eip7702SigningProvider({ redis: mockRedis });
      const result = await provider.isAvailable(testAddress);

      expect(result).toBe(false);
    });

    it('returns false when pool count is null', async () => {
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const provider = new Eip7702SigningProvider({ redis: mockRedis });
      const result = await provider.isAvailable(testAddress);

      expect(result).toBe(false);
    });

    it('returns false when Redis call fails', async () => {
      (mockRedis.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Redis error'));

      const provider = new Eip7702SigningProvider({ redis: mockRedis });
      const result = await provider.isAvailable(testAddress);

      expect(result).toBe(false);
    });
  });
});

describe('storePreSignedSignature', () => {
  let mockRedis: RedisClient;

  beforeEach(() => {
    mockRedis = createMockRedis();
    vi.clearAllMocks();
  });

  it('stores signature in Redis with correct key', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
    (mockRedis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const params = {
      address: '0x1234567890123456789012345678901234567890',
      signalHash: '0xabcdef',
      signature: '0xsignature',
    };

    await storePreSignedSignature(mockRedis, params);

    expect(mockRedis.set).toHaveBeenCalledWith(
      `signing:pool:${params.address}:${params.signalHash}`,
      expect.stringContaining(params.signature),
      'EX',
      86400
    );
  });

  it('increments pool count', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
    (mockRedis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const params = {
      address: '0x1234567890123456789012345678901234567890',
      signalHash: '0xabcdef',
      signature: '0xsignature',
    };

    await storePreSignedSignature(mockRedis, params);

    expect(mockRedis.incr).toHaveBeenCalledWith(`signing:pool:count:${params.address}`);
  });

  it('uses TTL from params', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
    (mockRedis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const params = {
      address: '0x1234567890123456789012345678901234567890',
      signalHash: '0xabcdef',
      signature: '0xsignature',
      ttlSeconds: 3600,
    };

    await storePreSignedSignature(mockRedis, params);

    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'EX',
      3600
    );
  });

  it('stores signature data as JSON', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
    (mockRedis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const params = {
      address: '0x1234567890123456789012345678901234567890',
      signalHash: '0xabcdef',
      signature: '0xsignature',
    };

    await storePreSignedSignature(mockRedis, params);

    const callArgs = (mockRedis.set as ReturnType<typeof vi.fn>).mock.calls[0];
    const storedData = JSON.parse(callArgs[1]);

    expect(storedData.signature).toBe(params.signature);
    expect(storedData.address).toBe(params.address);
    expect(storedData.createdAt).toBeDefined();
  });
});

describe('getPoolSize', () => {
  let mockRedis: RedisClient;

  beforeEach(() => {
    mockRedis = createMockRedis();
    vi.clearAllMocks();
  });

  it('returns count from Redis', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue('10');

    const address = '0x1234567890123456789012345678901234567890';
    const result = await getPoolSize(mockRedis, address);

    expect(result).toBe(10);
    expect(mockRedis.get).toHaveBeenCalledWith(`signing:pool:count:${address}`);
  });

  it('returns 0 when no signatures stored', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const address = '0x1234567890123456789012345678901234567890';
    const result = await getPoolSize(mockRedis, address);

    expect(result).toBe(0);
  });

  it('returns 0 when Redis call fails', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Redis error'));

    const address = '0x1234567890123456789012345678901234567890';
    const result = await getPoolSize(mockRedis, address);

    expect(result).toBe(0);
  });
});

describe('createBatchSigningHandler', () => {
  let mockRedis: RedisClient;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      body: {},
    };
    mockRes = {
      status: statusMock,
      json: jsonMock,
    };
  });

  it('stores multiple signatures', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
    (mockRedis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    mockReq.body = {
      address: '0x1234567890123456789012345678901234567890',
      signatures: [
        { signalHash: '0xhash1', signature: '0xsig1' },
        { signalHash: '0xhash2', signature: '0xsig2' },
      ],
    };

    const handler = createBatchSigningHandler(mockRedis);
    await handler(mockReq as Request, mockRes as Response, vi.fn());

    expect(mockRedis.set).toHaveBeenCalledTimes(2);
    expect(mockRedis.incr).toHaveBeenCalledTimes(2);
    expect(jsonMock).toHaveBeenCalledWith({
      stored: 2,
      address: mockReq.body.address,
    });
  });

  it('returns stored count', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
    (mockRedis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    mockReq.body = {
      address: '0x1234567890123456789012345678901234567890',
      signatures: [
        { signalHash: '0xhash1', signature: '0xsig1' },
      ],
    };

    const handler = createBatchSigningHandler(mockRedis);
    await handler(mockReq as Request, mockRes as Response, vi.fn());

    expect(jsonMock).toHaveBeenCalledWith({
      stored: 1,
      address: mockReq.body.address,
    });
  });

  it('returns 400 for missing address', async () => {
    mockReq.body = {
      signatures: [
        { signalHash: '0xhash1', signature: '0xsig1' },
      ],
    };

    const handler = createBatchSigningHandler(mockRedis);
    await handler(mockReq as Request, mockRes as Response, vi.fn());

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({
      error: 'Missing required field: address',
    });
  });

  it('returns 400 for empty signatures array', async () => {
    mockReq.body = {
      address: '0x1234567890123456789012345678901234567890',
      signatures: [],
    };

    const handler = createBatchSigningHandler(mockRedis);
    await handler(mockReq as Request, mockRes as Response, vi.fn());

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({
      error: 'signatures array cannot be empty',
    });
  });

  it('returns 400 for missing signatures field', async () => {
    mockReq.body = {
      address: '0x1234567890123456789012345678901234567890',
    };

    const handler = createBatchSigningHandler(mockRedis);
    await handler(mockReq as Request, mockRes as Response, vi.fn());

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({
      error: 'Missing required field: signatures',
    });
  });

  it('returns 400 for invalid signature entry', async () => {
    mockReq.body = {
      address: '0x1234567890123456789012345678901234567890',
      signatures: [
        { signalHash: '0xhash1' }, // missing signature
      ],
    };

    const handler = createBatchSigningHandler(mockRedis);
    await handler(mockReq as Request, mockRes as Response, vi.fn());

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({
      error: 'Each signature entry must have signalHash and signature as non-empty strings',
    });
  });
});
