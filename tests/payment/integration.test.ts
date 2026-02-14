import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { getAgentCardHandler } from '../../src/a2a/agentCard.js';
import { createA2aHandler } from '../../src/a2a/taskHandler.js';
import { TaskStore } from '../../src/a2a/taskStore.js';
import { TaskEventEmitter } from '../../src/a2a/streaming.js';
import { createPaymentMiddleware } from '../../src/payment/x402Middleware.js';
import { createPaymentGate, getPaymentModeConfig } from '../../src/payment/freeTier.js';
import { PaymentFacilitator } from '../../src/payment/facilitator.js';
import type { Config } from '../../src/config/index.js';

// Mock x402 imports
vi.mock('@x402/express', () => ({
  paymentMiddleware: vi.fn(() => vi.fn((_req: any, _res: any, next: any) => next())),
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

// Mock ioredis
vi.mock('ioredis', () => {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const mockRedis = {
    get: vi.fn(async (key: string) => store.get(key) || null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1; }),
    lpush: vi.fn(async () => 1),
    sadd: vi.fn(async (key: string, member: string) => {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key)!.add(member);
      return 1;
    }),
    srem: vi.fn(async (key: string, member: string) => {
      sets.get(key)?.delete(member);
      return 1;
    }),
    smembers: vi.fn(async (key: string) => [...(sets.get(key) || [])]),
    quit: vi.fn(),
    status: 'ready',
  };
  return { default: vi.fn(() => mockRedis), Redis: vi.fn(() => mockRedis) };
});

import { createRedisClient } from '../../src/redis/client.js';

describe('Payment Integration Tests', () => {
  let app: Express;
  let mockConfig: Config;
  let taskStore: TaskStore;
  let paymentFacilitator: PaymentFacilitator;

  function setupApp(paymentMode: 'disabled' | 'testnet' | 'mainnet') {
    app = express();
    app.use(express.json());

    mockConfig = {
      nodeEnv: 'test',
      port: 3100,
      circuitsDir: '/tmp/circuits',
      circuitsRepoUrl: 'https://github.com/example/circuits',
      redisUrl: 'redis://localhost:6379',
      paymentMode,
      paymentPayTo: paymentMode !== 'disabled' ? '0x1234567890123456789012345678901234567890' : '',
      paymentFacilitatorUrl: 'https://www.x402.org/facilitator',
      paymentProofPrice: '$0.10',
      a2aBaseUrl: 'https://test.example.com',
      agentVersion: '1.0.0',
    } as Config;

    const redis = createRedisClient('redis://localhost:6379');
    taskStore = new TaskStore(redis, 86400);
    const taskEventEmitter = new TaskEventEmitter();
    paymentFacilitator = new PaymentFacilitator(redis, { ttlSeconds: 86400 });

    const paymentMw = createPaymentMiddleware(mockConfig);

    // Health endpoint
    app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        service: 'proofport-ai',
        paymentMode: mockConfig.paymentMode,
      });
    });

    // Payment status endpoint
    const modeConfig = getPaymentModeConfig(mockConfig.paymentMode);
    app.get('/payment/status', (_req, res) => {
      res.json(modeConfig);
    });

    // Public routes (no payment gate)
    app.get('/.well-known/agent.json', getAgentCardHandler(mockConfig));

    // Payment-gated routes
    app.post('/a2a', paymentMw, createA2aHandler({ taskStore, taskEventEmitter }));
    app.post('/mcp', paymentMw, (_req, res) => {
      res.json({ jsonrpc: '2.0', result: { service: 'mcp' } });
    });
  }

  describe('Payment mode: disabled', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      setupApp('disabled');
    });

    it('health endpoint shows paymentMode disabled', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body.paymentMode).toBe('disabled');
    });

    it('payment status returns disabled config', async () => {
      const response = await request(app).get('/payment/status');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        mode: 'disabled',
        network: null,
        requiresPayment: false,
      });
    });

    it('POST /a2a works without payment header', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/get',
          params: { id: 'non-existent' },
        });

      expect(response.status).toBe(200);
      // tasks/get returns error for non-existent task, proving the route is accessible
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe(-32001);
    });

    it('POST /mcp works without payment header', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({ jsonrpc: '2.0', method: 'test' });

      expect(response.status).toBe(200);
      expect(response.body.result).toMatchObject({ service: 'mcp' });
    });

    it('Agent Card is accessible without payment', async () => {
      const response = await request(app).get('/.well-known/agent.json');
      expect(response.status).toBe(200);
      expect(response.body.name).toBe('ZKProofport Prover Agent');
    });
  });

  describe('Payment mode: testnet', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      setupApp('testnet');
    });

    it('health endpoint shows paymentMode testnet', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body.paymentMode).toBe('testnet');
    });

    it('payment status returns testnet config with Base Sepolia network', async () => {
      const response = await request(app).get('/payment/status');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        mode: 'testnet',
        network: 'eip155:84532',
        requiresPayment: true,
      });
    });

    it('POST /a2a passes through when x402 middleware allows (mocked)', async () => {
      // x402 middleware is mocked to always call next()
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/get',
          params: { id: 'non-existent' },
        });

      expect(response.status).toBe(200);
      expect(response.body.error.code).toBe(-32001);
    });

    it('Agent Card remains accessible without payment', async () => {
      const response = await request(app).get('/.well-known/agent.json');
      expect(response.status).toBe(200);
      expect(response.body.securitySchemes).toBeDefined();
      expect(response.body.securitySchemes.x402).toBeDefined();
    });
  });

  describe('Payment mode: mainnet', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      setupApp('mainnet');
    });

    it('payment status returns mainnet config with Base network', async () => {
      const response = await request(app).get('/payment/status');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        mode: 'mainnet',
        network: 'eip155:8453',
        requiresPayment: true,
      });
    });
  });

  describe('PaymentFacilitator integration', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      setupApp('disabled');
    });

    it('records and retrieves payment for a task', async () => {
      const payment = await paymentFacilitator.recordPayment({
        taskId: 'task-integration-1',
        payerAddress: '0xabc123',
        amount: '$0.10',
        network: 'eip155:84532',
      });

      expect(payment.status).toBe('pending');
      expect(payment.taskId).toBe('task-integration-1');

      const retrieved = await paymentFacilitator.getPaymentByTaskId('task-integration-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(payment.id);
    });

    it('settles payment after proof completion', async () => {
      const payment = await paymentFacilitator.recordPayment({
        taskId: 'task-integration-2',
        payerAddress: '0xdef456',
        amount: '$0.10',
        network: 'eip155:8453',
      });

      const settled = await paymentFacilitator.settlePayment(payment.id);
      expect(settled.status).toBe('settled');
    });

    it('refunds payment on proof failure', async () => {
      const payment = await paymentFacilitator.recordPayment({
        taskId: 'task-integration-3',
        payerAddress: '0xghi789',
        amount: '$0.10',
        network: 'eip155:8453',
      });

      const refunded = await paymentFacilitator.refundPayment(payment.id, 'Circuit compilation failed');
      expect(refunded.status).toBe('refunded');
    });
  });

  describe('createPaymentGate middleware', () => {
    it('disabled mode passes all requests through', async () => {
      const gateApp = express();
      gateApp.use(express.json());
      gateApp.use(createPaymentGate({ paymentMode: 'disabled' }));
      gateApp.post('/test', (_req, res) => res.json({ ok: true }));

      const response = await request(gateApp).post('/test').send({});
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    it('testnet mode blocks requests without X-PAYMENT header', async () => {
      const gateApp = express();
      gateApp.use(express.json());
      gateApp.use(createPaymentGate({ paymentMode: 'testnet' }));
      gateApp.post('/test', (_req, res) => res.json({ ok: true }));

      const response = await request(gateApp).post('/test').send({});
      expect(response.status).toBe(402);
      expect(response.body.error).toBe('Payment Required');
      expect(response.body.network).toBe('eip155:84532');
    });

    it('testnet mode allows requests with X-PAYMENT header', async () => {
      const gateApp = express();
      gateApp.use(express.json());
      gateApp.use(createPaymentGate({ paymentMode: 'testnet' }));
      gateApp.post('/test', (_req, res) => res.json({ ok: true }));

      const response = await request(gateApp)
        .post('/test')
        .set('X-PAYMENT', 'valid-payment-token')
        .send({});
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
  });
});
