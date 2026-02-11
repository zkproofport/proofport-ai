import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { createSigningCallbackHandler } from '../../src/signing/webSigning.js';
import { createBatchSigningHandler } from '../../src/signing/eip7702Signing.js';

// Mock ioredis
vi.mock('ioredis', () => {
  const store = new Map<string, string>();
  const mockRedis = {
    get: vi.fn(async (key: string) => store.get(key) || null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1; }),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    quit: vi.fn(),
    status: 'ready',
  };
  return { default: vi.fn(() => mockRedis), Redis: vi.fn(() => mockRedis) };
});

import { createRedisClient } from '../../src/redis/client.js';

describe('Signing Integration Tests', () => {
  let app: Express;
  let redis: ReturnType<typeof createRedisClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    redis = createRedisClient('redis://localhost:6379');

    // Mount signing routes
    app.post('/api/signing/callback/:requestId', createSigningCallbackHandler(redis));
    app.post('/api/signing/batch', createBatchSigningHandler(redis));

    // Signing status endpoint
    app.get('/signing/status', (_req, res) => {
      res.json({
        providers: {
          privy: { enabled: false },
          web: { enabled: true, signPageUrl: 'https://sign.zkproofport.app' },
          eip7702: { enabled: true },
        },
      });
    });
  });

  describe('GET /signing/status', () => {
    it('returns signing provider status', async () => {
      const response = await request(app).get('/signing/status');
      expect(response.status).toBe(200);
      expect(response.body.providers).toBeDefined();
      expect(response.body.providers.privy).toMatchObject({ enabled: false });
      expect(response.body.providers.web).toMatchObject({ enabled: true });
      expect(response.body.providers.eip7702).toMatchObject({ enabled: true });
    });

    it('web provider includes signPageUrl', async () => {
      const response = await request(app).get('/signing/status');
      expect(response.body.providers.web.signPageUrl).toBe('https://sign.zkproofport.app');
    });
  });

  describe('POST /api/signing/callback/:requestId', () => {
    it('returns 404 for non-existent requestId', async () => {
      const response = await request(app)
        .post('/api/signing/callback/nonexistent-id')
        .send({
          signature: '0x' + 'ab'.repeat(64),
          address: '0x1234567890123456789012345678901234567890',
        });

      expect(response.status).toBe(404);
    });

    it('returns 400 when signature is missing', async () => {
      // Store a pending request
      const record = {
        id: 'test-request-1',
        address: '0x1234567890123456789012345678901234567890',
        signalHash: '0x' + 'aa'.repeat(32),
        scope: 'test-scope',
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(JSON.stringify(record));

      const response = await request(app)
        .post('/api/signing/callback/test-request-1')
        .send({ address: '0x1234567890123456789012345678901234567890' });

      expect(response.status).toBe(400);
    });

    it('returns 200 on valid callback with matching address', async () => {
      const record = {
        id: 'test-request-2',
        address: '0x1234567890123456789012345678901234567890',
        signalHash: '0x' + 'bb'.repeat(32),
        scope: 'test-scope',
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
      (redis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(JSON.stringify(record));
      (redis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce('OK');

      const response = await request(app)
        .post('/api/signing/callback/test-request-2')
        .send({
          signature: '0x' + 'cc'.repeat(64),
          address: '0x1234567890123456789012345678901234567890',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/signing/batch', () => {
    it('stores batch of pre-signed signatures', async () => {
      (redis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (redis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      (redis.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const response = await request(app)
        .post('/api/signing/batch')
        .send({
          address: '0x1234567890123456789012345678901234567890',
          signatures: [
            { signalHash: '0x' + 'aa'.repeat(32), signature: '0x' + 'bb'.repeat(64) },
            { signalHash: '0x' + 'cc'.repeat(32), signature: '0x' + 'dd'.repeat(64) },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.stored).toBe(2);
      expect(response.body.address).toBe('0x1234567890123456789012345678901234567890');
    });

    it('returns 400 for missing address', async () => {
      const response = await request(app)
        .post('/api/signing/batch')
        .send({
          signatures: [{ signalHash: '0xabc', signature: '0xdef' }],
        });

      expect(response.status).toBe(400);
    });

    it('returns 400 for empty signatures array', async () => {
      const response = await request(app)
        .post('/api/signing/batch')
        .send({
          address: '0x1234567890123456789012345678901234567890',
          signatures: [],
        });

      expect(response.status).toBe(400);
    });

    it('returns 400 for missing signatures field', async () => {
      const response = await request(app)
        .post('/api/signing/batch')
        .send({
          address: '0x1234567890123456789012345678901234567890',
        });

      expect(response.status).toBe(400);
    });
  });
});
