import { randomUUID } from 'crypto';
import type { RedisClient } from '../redis/client.js';

export interface A2aTask {
  id: string;
  status: 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';
  skill: string;
  params: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

type TaskStatus = A2aTask['status'];

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  submitted: ['working', 'canceled'],
  working: ['completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

export class TaskStore {
  constructor(
    private redis: RedisClient,
    private ttlSeconds: number = 86400
  ) {}

  async createTask(skill: string, params: Record<string, unknown>): Promise<A2aTask> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const task: A2aTask = {
      id,
      status: 'submitted',
      skill,
      params,
      createdAt: now,
      updatedAt: now,
    };

    const key = `a2a:task:${id}`;
    await this.redis.set(key, JSON.stringify(task), 'EX', this.ttlSeconds);
    await this.redis.lpush('a2a:queue:submitted', id);

    return task;
  }

  async getTask(id: string): Promise<A2aTask | null> {
    const key = `a2a:task:${id}`;
    const data = await this.redis.get(key);

    if (!data) {
      return null;
    }

    return JSON.parse(data) as A2aTask;
  }

  async updateTaskStatus(
    id: string,
    status: TaskStatus,
    result?: Record<string, unknown>,
    error?: string
  ): Promise<A2aTask> {
    const task = await this.getTask(id);

    if (!task) {
      throw new Error('Task not found');
    }

    // Validate transition
    const validNextStates = VALID_TRANSITIONS[task.status];
    if (!validNextStates.includes(status)) {
      throw new Error(`Invalid status transition from ${task.status} to ${status}`);
    }

    const updatedTask: A2aTask = {
      ...task,
      status,
      updatedAt: new Date().toISOString(),
    };

    if (result !== undefined) {
      updatedTask.result = result;
    }

    if (error !== undefined) {
      updatedTask.error = error;
    }

    const key = `a2a:task:${id}`;
    await this.redis.set(key, JSON.stringify(updatedTask), 'EX', this.ttlSeconds);

    return updatedTask;
  }
}
