import type { Task } from '@a2a-js/sdk';
import type { TaskStore, ServerCallContext } from '@a2a-js/sdk/server';
import type { RedisClient } from '../redis/client.js';

export class RedisTaskStore implements TaskStore {
  constructor(
    public readonly redis: RedisClient,
    private ttlSeconds: number = 86400
  ) {}

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    await this.redis.set(`a2a:task:${task.id}`, JSON.stringify(task), 'EX', this.ttlSeconds);
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    const data = await this.redis.get(`a2a:task:${taskId}`);
    if (!data) return undefined;
    return JSON.parse(data) as Task;
  }

  async setContextFlow(contextId: string, requestId: string): Promise<void> {
    await this.redis.set(`a2a:ctx:${contextId}`, requestId, 'EX', this.ttlSeconds);
  }

  async getContextFlow(contextId: string): Promise<string | null> {
    return this.redis.get(`a2a:ctx:${contextId}`);
  }
}
