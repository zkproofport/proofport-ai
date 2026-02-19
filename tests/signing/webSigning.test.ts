import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SigningRequest } from '../../src/signing/types.js';

// Mock ioredis
vi.mock('ioredis', () => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    quit: vi.fn(),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    status: 'ready',
  };
  return { default: vi.fn(() => mockRedis), Redis: vi.fn(() => mockRedis) };
});

import { createRedisClient, type RedisClient } from '../../src/redis/client.js';
import {
  WebSigningProvider,
  getSigningUrl,
  createSigningCallbackHandler,
} from '../../src/signing/webSigning.js';

// Mock Express req/res helpers
function createMockReq(params: any, body: any) {
  return { params, body } as any;
}

function createMockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnThis();
  res.json = vi.fn().mockReturnThis();
  return res;
}

describe('WebSigningProvider', () => {
  let mockRedis: RedisClient;
  let provider: WebSigningProvider;
  const signPageUrl = 'https://sign.zkproofport.app';
  const callbackBaseUrl = 'https://ai.zkproofport.app';

  beforeEach(() => {
    mockRedis = createRedisClient('redis://localhost:6379');
    vi.clearAllMocks();
    provider = new WebSigningProvider({
      redis: mockRedis,
      signPageUrl,
      callbackBaseUrl,
      ttlSeconds: 300,
    });
  });

  describe('constructor and properties', () => {
    it('should set method to "web"', () => {
      expect(provider.method).toBe('web');
    });
  });

  describe('isAvailable', () => {
    it('should always return true for any address', async () => {
      expect(await provider.isAvailable('0x1234567890123456789012345678901234567890')).toBe(true);
      expect(await provider.isAvailable('0xaabbccdd00112233445566778899aabbccddeeff')).toBe(true);
      expect(await provider.isAvailable('0xdeadbeef00000000000000000000000000000001')).toBe(true);
    });
  });

  describe('sign - request creation', () => {
    it('should create signing request in Redis with pending status', async () => {
      const request: SigningRequest = {
        address: '0x1234567890123456789012345678901234567890',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        scope: 'zkproofport:kyc:v1',
        method: 'web',
      };

      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      // Start signing (don't await, we'll test the Redis call)
      const signPromise = provider.sign(request);

      // Wait a tick for the initial Redis set to happen
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Check that Redis.set was called
      expect(mockRedis.set).toHaveBeenCalled();
      const setCall = (mockRedis.set as ReturnType<typeof vi.fn>).mock.calls[0];
      const key = setCall[0] as string;
      const value = setCall[1] as string;
      const exMode = setCall[2];
      const ttl = setCall[3];

      expect(key).toMatch(/^signing:/);
      expect(exMode).toBe('EX');
      expect(ttl).toBe(300);

      const record = JSON.parse(value);
      expect(record.address).toBe(request.address);
      expect(record.signalHash).toBe(request.signalHash);
      expect(record.scope).toBe(request.scope);
      expect(record.status).toBe('pending');
      expect(record.signature).toBeUndefined();
      expect(record.createdAt).toBeDefined();
      expect(record.expiresAt).toBeDefined();

      // Clean up the promise (will timeout since we didn't complete it)
      signPromise.catch(() => {});
    });

    it('should store request with correct TTL', async () => {
      const customProvider = new WebSigningProvider({
        redis: mockRedis,
        signPageUrl,
        callbackBaseUrl,
        ttlSeconds: 600,
      });

      const request: SigningRequest = {
        address: '0x1234567890123456789012345678901234567890',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        scope: 'zkproofport:kyc:v1',
        method: 'web',
      };

      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const signPromise = customProvider.sign(request);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const setCall = (mockRedis.set as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(setCall[3]).toBe(600);

      signPromise.catch(() => {});
    });
  });

  describe('getSigningUrl', () => {
    it('should generate correct URL', () => {
      const requestId = '550e8400-e29b-41d4-a716-446655440000';
      const url = getSigningUrl(signPageUrl, requestId);
      expect(url).toBe('https://sign.zkproofport.app/s/550e8400-e29b-41d4-a716-446655440000');
    });

    it('should handle signPageUrl without trailing slash', () => {
      const requestId = '550e8400-e29b-41d4-a716-446655440001';
      const url = getSigningUrl('https://sign.zkproofport.app/', requestId);
      expect(url).toBe('https://sign.zkproofport.app/s/550e8400-e29b-41d4-a716-446655440001');
    });
  });
});

describe('createSigningCallbackHandler', () => {
  let mockRedis: RedisClient;
  let handler: any;

  beforeEach(() => {
    mockRedis = createRedisClient('redis://localhost:6379');
    vi.clearAllMocks();
    handler = createSigningCallbackHandler(mockRedis);
  });

  it('should return 404 for non-existent requestId', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const req = createMockReq({ requestId: '550e8400-e29b-41d4-a716-446655440000' }, {});
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Request not found or expired',
    });
  });

  it('should return 400 if signature field missing in body', async () => {
    const record = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      address: '0x1234567890123456789012345678901234567890',
      signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      scope: 'zkproofport:kyc:v1',
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

    const req = createMockReq(
      { requestId: '550e8400-e29b-41d4-a716-446655440000' },
      { address: '0x1234567890123456789012345678901234567890' },
    );
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Missing signature or address',
    });
  });

  it('should return 400 if address field missing in body', async () => {
    const record = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      address: '0x1234567890123456789012345678901234567890',
      signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      scope: 'zkproofport:kyc:v1',
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

    const req = createMockReq(
      { requestId: '550e8400-e29b-41d4-a716-446655440000' },
      { signature: '0xabcd' },
    );
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Missing signature or address',
    });
  });

  it('should return 400 if address does not match expected address', async () => {
    const record = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      address: '0x1234567890123456789012345678901234567890',
      signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      scope: 'zkproofport:kyc:v1',
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

    const req = createMockReq(
      { requestId: '550e8400-e29b-41d4-a716-446655440000' },
      {
        signature: '0x' + 'ab'.repeat(64),
        address: '0xdifferent0000000000000000000000000000000',
      },
    );
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Address mismatch',
    });
  });

  it('should return 200 and update record on valid callback', async () => {
    const record = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      address: '0x1234567890123456789012345678901234567890',
      signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      scope: 'zkproofport:kyc:v1',
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const req = createMockReq(
      { requestId: '550e8400-e29b-41d4-a716-446655440000' },
      {
        signature: '0x' + 'ab'.repeat(64),
        address: '0x1234567890123456789012345678901234567890',
      },
    );
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('should update record with status completed and signature', async () => {
    const record = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      address: '0x1234567890123456789012345678901234567890',
      signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      scope: 'zkproofport:kyc:v1',
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const signature = '0x' + 'cd'.repeat(64);
    const req = createMockReq(
      { requestId: '550e8400-e29b-41d4-a716-446655440000' },
      {
        signature,
        address: '0x1234567890123456789012345678901234567890',
      },
    );
    const res = createMockRes();

    await handler(req, res);

    const setCall = (mockRedis.set as ReturnType<typeof vi.fn>).mock.calls[0];
    const updatedRecord = JSON.parse(setCall[1]);

    expect(updatedRecord.status).toBe('completed');
    expect(updatedRecord.signature).toBe(signature);
  });

  it('should return 404 for already completed request', async () => {
    const record = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      address: '0x1234567890123456789012345678901234567890',
      signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      scope: 'zkproofport:kyc:v1',
      status: 'completed',
      signature: '0x' + 'ef'.repeat(64),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(record));

    const req = createMockReq(
      { requestId: '550e8400-e29b-41d4-a716-446655440000' },
      {
        signature: '0x' + 'ab'.repeat(64),
        address: '0x1234567890123456789012345678901234567890',
      },
    );
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Request not found or expired',
    });
  });
});
