import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ioredis
vi.mock('ioredis', () => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    sadd: vi.fn(),
    srem: vi.fn(),
    smembers: vi.fn(),
    quit: vi.fn(),
    status: 'ready',
  };
  return { default: vi.fn(() => mockRedis), Redis: vi.fn(() => mockRedis) };
});

import { createRedisClient, type RedisClient } from '../../src/redis/client.js';
import { PaymentFacilitator, type PaymentRecord } from '../../src/payment/facilitator.js';

describe('PaymentFacilitator', () => {
  let mockRedis: RedisClient;
  let facilitator: PaymentFacilitator;

  beforeEach(() => {
    mockRedis = createRedisClient('redis://localhost:6379');
    vi.clearAllMocks();
    facilitator = new PaymentFacilitator(mockRedis, {
      ttlSeconds: 86400,
      keyPrefix: 'payment',
    });
  });

  describe('recordPayment', () => {
    it('should create a payment record with pending status', async () => {
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (mockRedis.sadd as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await facilitator.recordPayment({
        taskId: 'task-123',
        payerAddress: '0xabc123',
        amount: '$0.10',
        network: 'eip155:8453',
      });

      expect(result.taskId).toBe('task-123');
      expect(result.payerAddress).toBe('0xabc123');
      expect(result.amount).toBe('$0.10');
      expect(result.network).toBe('eip155:8453');
      expect(result.status).toBe('pending');
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it('should store in Redis with correct key prefix', async () => {
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (mockRedis.sadd as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await facilitator.recordPayment({
        taskId: 'task-123',
        payerAddress: '0xabc123',
        amount: '$0.10',
        network: 'eip155:8453',
      });

      expect(mockRedis.set).toHaveBeenCalledWith(
        `payment:${result.id}`,
        expect.any(String),
        'EX',
        86400,
      );
    });

    it('should create task index mapping', async () => {
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (mockRedis.sadd as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await facilitator.recordPayment({
        taskId: 'task-456',
        payerAddress: '0xdef456',
        amount: '$0.10',
        network: 'eip155:84532',
      });

      expect(mockRedis.set).toHaveBeenCalledWith(
        'payment:task:task-456',
        result.id,
        'EX',
        86400,
      );
    });

    it('should add to pending status set', async () => {
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (mockRedis.sadd as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await facilitator.recordPayment({
        taskId: 'task-789',
        payerAddress: '0xghi789',
        amount: '$0.10',
        network: 'eip155:8453',
      });

      expect(mockRedis.sadd).toHaveBeenCalledWith('payment:status:pending', result.id);
    });
  });

  describe('getPayment', () => {
    it('should return stored payment record', async () => {
      const storedPayment: PaymentRecord = {
        id: 'payment-123',
        taskId: 'task-123',
        payerAddress: '0xabc123',
        amount: '$0.10',
        network: 'eip155:8453',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(storedPayment));

      const result = await facilitator.getPayment('payment-123');

      expect(result).toEqual(storedPayment);
      expect(mockRedis.get).toHaveBeenCalledWith('payment:payment-123');
    });

    it('should return null for non-existent payment', async () => {
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await facilitator.getPayment('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getPaymentByTaskId', () => {
    it('should return payment via task index', async () => {
      const storedPayment: PaymentRecord = {
        id: 'payment-456',
        taskId: 'task-456',
        payerAddress: '0xdef456',
        amount: '$0.10',
        network: 'eip155:8453',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (mockRedis.get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce('payment-456') // task index lookup
        .mockResolvedValueOnce(JSON.stringify(storedPayment)); // payment record

      const result = await facilitator.getPaymentByTaskId('task-456');

      expect(result).toEqual(storedPayment);
      expect(mockRedis.get).toHaveBeenNthCalledWith(1, 'payment:task:task-456');
      expect(mockRedis.get).toHaveBeenNthCalledWith(2, 'payment:payment-456');
    });

    it('should return null for non-existent task', async () => {
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await facilitator.getPaymentByTaskId('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('settlePayment', () => {
    it('should transition pending to settled', async () => {
      const pendingPayment: PaymentRecord = {
        id: 'payment-settle-1',
        taskId: 'task-settle',
        payerAddress: '0xsettle',
        amount: '$0.10',
        network: 'eip155:8453',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(pendingPayment));
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (mockRedis.srem as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      (mockRedis.sadd as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await facilitator.settlePayment('payment-settle-1');

      expect(result.status).toBe('settled');
      expect(result.id).toBe('payment-settle-1');
      expect(result.updatedAt).toBeDefined();
      expect(mockRedis.srem).toHaveBeenCalledWith('payment:status:pending', 'payment-settle-1');
      expect(mockRedis.sadd).toHaveBeenCalledWith('payment:status:settled', 'payment-settle-1');
    });

    it('should throw for non-existent payment', async () => {
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(facilitator.settlePayment('nonexistent')).rejects.toThrow(
        'Payment not found: nonexistent',
      );
    });

    it('should throw for already settled payment', async () => {
      const settledPayment: PaymentRecord = {
        id: 'payment-settled',
        taskId: 'task-settled',
        payerAddress: '0xsettled',
        amount: '$0.10',
        network: 'eip155:8453',
        status: 'settled',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(settledPayment));

      await expect(facilitator.settlePayment('payment-settled')).rejects.toThrow(
        'Invalid state transition: settled -> settled',
      );
    });
  });

  describe('refundPayment', () => {
    it('should transition pending to refunded with reason', async () => {
      const pendingPayment: PaymentRecord = {
        id: 'payment-refund-1',
        taskId: 'task-refund',
        payerAddress: '0xrefund',
        amount: '$0.10',
        network: 'eip155:8453',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(pendingPayment));
      (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');
      (mockRedis.srem as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      (mockRedis.sadd as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await facilitator.refundPayment('payment-refund-1', 'Proof generation failed');

      expect(result.status).toBe('refunded');
      expect(result.id).toBe('payment-refund-1');
      expect(result.updatedAt).toBeDefined();
      expect(mockRedis.srem).toHaveBeenCalledWith('payment:status:pending', 'payment-refund-1');
      expect(mockRedis.sadd).toHaveBeenCalledWith('payment:status:refunded', 'payment-refund-1');
    });

    it('should throw for already refunded payment', async () => {
      const refundedPayment: PaymentRecord = {
        id: 'payment-refunded',
        taskId: 'task-refunded',
        payerAddress: '0xrefunded',
        amount: '$0.10',
        network: 'eip155:8453',
        status: 'refunded',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(refundedPayment));

      await expect(
        facilitator.refundPayment('payment-refunded', 'Another reason'),
      ).rejects.toThrow('Invalid state transition: refunded -> refunded');
    });

    it('should throw for settled payment (cannot refund settled)', async () => {
      const settledPayment: PaymentRecord = {
        id: 'payment-settled-no-refund',
        taskId: 'task-settled',
        payerAddress: '0xsettled',
        amount: '$0.10',
        network: 'eip155:8453',
        status: 'settled',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(settledPayment));

      await expect(
        facilitator.refundPayment('payment-settled-no-refund', 'Try to refund'),
      ).rejects.toThrow('Invalid state transition: settled -> refunded');
    });
  });

  describe('listPayments', () => {
    it('should return all payments (no filter)', async () => {
      const payment1: PaymentRecord = {
        id: 'payment-1',
        taskId: 'task-1',
        payerAddress: '0x1',
        amount: '$0.10',
        network: 'eip155:8453',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const payment2: PaymentRecord = {
        id: 'payment-2',
        taskId: 'task-2',
        payerAddress: '0x2',
        amount: '$0.10',
        network: 'eip155:8453',
        status: 'settled',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (mockRedis.smembers as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['payment-1'])
        .mockResolvedValueOnce(['payment-2'])
        .mockResolvedValueOnce([]);

      (mockRedis.get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(JSON.stringify(payment1))
        .mockResolvedValueOnce(JSON.stringify(payment2));

      const result = await facilitator.listPayments();

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(payment1);
      expect(result).toContainEqual(payment2);
    });

    it('should filter by status', async () => {
      const payment1: PaymentRecord = {
        id: 'payment-pending-1',
        taskId: 'task-1',
        payerAddress: '0x1',
        amount: '$0.10',
        network: 'eip155:8453',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (mockRedis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue(['payment-pending-1']);
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(payment1));

      const result = await facilitator.listPayments({ status: 'pending' });

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('pending');
      expect(mockRedis.smembers).toHaveBeenCalledWith('payment:status:pending');
    });
  });
});
