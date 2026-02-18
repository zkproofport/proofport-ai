import type { RedisClient } from './client.js';

export interface CleanupConfig {
  pollIntervalMs?: number;
}

export class CleanupWorker {
  private redis: RedisClient;
  private pollIntervalMs: number;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(redis: RedisClient, config?: CleanupConfig) {
    this.redis = redis;
    this.pollIntervalMs = config?.pollIntervalMs ?? 300000; // 5 minutes default
  }

  start(): void {
    if (this.intervalHandle) {
      console.log('CleanupWorker already running');
      return;
    }

    console.log(`CleanupWorker started (poll interval: ${this.pollIntervalMs}ms)`);
    this.intervalHandle = setInterval(() => {
      this.cleanupStaleEntries().catch((error) => {
        console.error('Error in cleanup processing cycle:', error);
      });
    }, this.pollIntervalMs);

    // Run first cycle immediately
    this.cleanupStaleEntries().catch((error) => {
      console.error('Error in initial cleanup processing cycle:', error);
    });
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log('CleanupWorker stopped');
    }
  }

  async cleanupStaleEntries(): Promise<void> {
    const [staleTaskCount, stalePaymentCount] = await Promise.all([
      this.cleanupTaskQueue(),
      this.cleanupPaymentStatusSets(),
    ]);

    // Only log if something was actually cleaned
    if (staleTaskCount > 0 || stalePaymentCount > 0) {
      console.log(
        `[Cleanup] Removed ${staleTaskCount} stale task IDs from queue, ${stalePaymentCount} stale payment IDs from status sets`,
      );
    }
  }

  private async cleanupTaskQueue(): Promise<number> {
    const queueKey = 'a2a:queue:submitted';
    const taskIds = await this.redis.lrange(queueKey, 0, -1);

    if (taskIds.length === 0) {
      return 0;
    }

    let removedCount = 0;

    for (const taskId of taskIds) {
      const taskKey = `a2a:task:${taskId}`;
      const exists = await this.redis.exists(taskKey);

      if (exists === 0) {
        // Task record doesn't exist, remove from queue
        await this.redis.lrem(queueKey, 0, taskId);
        removedCount++;
      }
    }

    return removedCount;
  }

  private async cleanupPaymentStatusSets(): Promise<number> {
    const statusSets = [
      'payment:status:pending',
      'payment:status:settled',
      'payment:status:refunded',
    ];

    let totalRemoved = 0;

    for (const setKey of statusSets) {
      const paymentIds = await this.redis.smembers(setKey);

      if (paymentIds.length === 0) {
        continue;
      }

      for (const paymentId of paymentIds) {
        const paymentKey = `payment:${paymentId}`;
        const exists = await this.redis.exists(paymentKey);

        if (exists === 0) {
          // Payment record doesn't exist, remove from set
          await this.redis.srem(setKey, paymentId);
          totalRemoved++;
        }
      }
    }

    return totalRemoved;
  }
}
