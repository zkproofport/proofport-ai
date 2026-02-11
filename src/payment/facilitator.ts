import { randomUUID } from 'node:crypto';
import type { RedisClient } from '../redis/client.js';

export interface PaymentRecord {
  id: string;
  taskId: string;
  payerAddress: string;
  amount: string;
  network: string;
  status: 'pending' | 'settled' | 'refunded';
  createdAt: string;
  updatedAt: string;
}

export interface PaymentFacilitatorConfig {
  ttlSeconds?: number;
  keyPrefix?: string;
}

export class PaymentFacilitator {
  private redis: RedisClient;
  private ttlSeconds: number;
  private keyPrefix: string;

  constructor(redis: RedisClient, config?: PaymentFacilitatorConfig) {
    this.redis = redis;
    this.ttlSeconds = config?.ttlSeconds ?? 86400; // 24 hours default
    this.keyPrefix = config?.keyPrefix ?? 'payment';
  }

  private buildKey(id: string): string {
    return `${this.keyPrefix}:${id}`;
  }

  private buildTaskKey(taskId: string): string {
    return `${this.keyPrefix}:task:${taskId}`;
  }

  private buildStatusKey(status: string): string {
    return `${this.keyPrefix}:status:${status}`;
  }

  async recordPayment(params: {
    taskId: string;
    payerAddress: string;
    amount: string;
    network: string;
  }): Promise<PaymentRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const record: PaymentRecord = {
      id,
      taskId: params.taskId,
      payerAddress: params.payerAddress,
      amount: params.amount,
      network: params.network,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    // Store main record
    await this.redis.set(this.buildKey(id), JSON.stringify(record), 'EX', this.ttlSeconds);

    // Store task index
    await this.redis.set(this.buildTaskKey(params.taskId), id, 'EX', this.ttlSeconds);

    // Add to status set
    await this.redis.sadd(this.buildStatusKey('pending'), id);

    return record;
  }

  async getPayment(paymentId: string): Promise<PaymentRecord | null> {
    const data = await this.redis.get(this.buildKey(paymentId));
    if (!data) return null;
    return JSON.parse(data) as PaymentRecord;
  }

  async getPaymentByTaskId(taskId: string): Promise<PaymentRecord | null> {
    const paymentId = await this.redis.get(this.buildTaskKey(taskId));
    if (!paymentId) return null;
    return this.getPayment(paymentId);
  }

  async settlePayment(paymentId: string): Promise<PaymentRecord> {
    const payment = await this.getPayment(paymentId);
    if (!payment) {
      throw new Error(`Payment not found: ${paymentId}`);
    }

    if (payment.status !== 'pending') {
      throw new Error(`Invalid state transition: ${payment.status} -> settled`);
    }

    const updatedPayment: PaymentRecord = {
      ...payment,
      status: 'settled',
      updatedAt: new Date().toISOString(),
    };

    // Update main record
    await this.redis.set(
      this.buildKey(paymentId),
      JSON.stringify(updatedPayment),
      'EX',
      this.ttlSeconds,
    );

    // Move between status sets
    await this.redis.srem(this.buildStatusKey('pending'), paymentId);
    await this.redis.sadd(this.buildStatusKey('settled'), paymentId);

    return updatedPayment;
  }

  async refundPayment(paymentId: string, reason: string): Promise<PaymentRecord> {
    const payment = await this.getPayment(paymentId);
    if (!payment) {
      throw new Error(`Payment not found: ${paymentId}`);
    }

    if (payment.status !== 'pending') {
      throw new Error(`Invalid state transition: ${payment.status} -> refunded`);
    }

    const updatedPayment: PaymentRecord = {
      ...payment,
      status: 'refunded',
      updatedAt: new Date().toISOString(),
    };

    // Update main record
    await this.redis.set(
      this.buildKey(paymentId),
      JSON.stringify(updatedPayment),
      'EX',
      this.ttlSeconds,
    );

    // Move between status sets
    await this.redis.srem(this.buildStatusKey('pending'), paymentId);
    await this.redis.sadd(this.buildStatusKey('refunded'), paymentId);

    return updatedPayment;
  }

  async listPayments(options?: { status?: string; limit?: number }): Promise<PaymentRecord[]> {
    let paymentIds: string[];

    if (options?.status) {
      // Get from specific status set
      paymentIds = await this.redis.smembers(this.buildStatusKey(options.status));
    } else {
      // Get from all status sets
      const pendingIds = await this.redis.smembers(this.buildStatusKey('pending'));
      const settledIds = await this.redis.smembers(this.buildStatusKey('settled'));
      const refundedIds = await this.redis.smembers(this.buildStatusKey('refunded'));
      paymentIds = [...pendingIds, ...settledIds, ...refundedIds];
    }

    // Apply limit if specified
    if (options?.limit && options.limit > 0) {
      paymentIds = paymentIds.slice(0, options.limit);
    }

    // Fetch all payment records
    const payments: PaymentRecord[] = [];
    for (const id of paymentIds) {
      const payment = await this.getPayment(id);
      if (payment) {
        payments.push(payment);
      }
    }

    return payments;
  }
}
