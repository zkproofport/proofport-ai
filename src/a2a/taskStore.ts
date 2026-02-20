import { randomUUID } from 'crypto';
import type { RedisClient } from '../redis/client.js';

// A2A v0.3 Part types
export interface TextPart {
  kind: 'text';
  text: string;
}

export interface FilePart {
  kind: 'file';
  file: {
    name: string;
    mimeType: string;
    uri?: string;
    bytes?: string;
  };
}

export interface DataPart {
  kind: 'data';
  mimeType: string;
  data: unknown;
}

export type Part = TextPart | FilePart | DataPart;

export interface Message {
  role: 'user' | 'agent';
  parts: Part[];
  timestamp?: string;
}

export interface Artifact {
  id: string;
  mimeType: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
}

export type TaskState = 'queued' | 'running' | 'completed' | 'canceled' | 'failed' | 'rejected' | 'auth-required';

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp?: string;
}

export interface A2aTask {
  id: string;
  contextId: string;
  status: TaskStatus;
  skill: string;
  params: Record<string, unknown>;
  history?: Message[];
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
  kind: 'task';
}

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ['running', 'canceled', 'rejected'],
  running: ['completed', 'failed', 'canceled', 'auth-required'],
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
  'auth-required': ['running', 'canceled'],
};

export class TaskStore {
  constructor(
    private redis: RedisClient,
    private ttlSeconds: number = 86400
  ) {}

  async createTask(
    skill: string,
    params: Record<string, unknown>,
    userMessage: Message,
    contextId?: string
  ): Promise<A2aTask> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const task: A2aTask = {
      id,
      contextId: contextId || randomUUID(),
      status: {
        state: 'queued',
        timestamp: now,
      },
      skill,
      params,
      history: [userMessage],
      artifacts: [],
      metadata: {},
      kind: 'task',
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
    state: TaskState,
    statusMessage?: Message
  ): Promise<A2aTask> {
    const task = await this.getTask(id);

    if (!task) {
      throw new Error('Task not found');
    }

    const validNextStates = VALID_TRANSITIONS[task.status.state];
    if (!validNextStates.includes(state)) {
      throw new Error(`Invalid status transition from ${task.status.state} to ${state}`);
    }

    task.status = {
      state,
      message: statusMessage,
      timestamp: new Date().toISOString(),
    };

    if (statusMessage) {
      if (!task.history) task.history = [];
      task.history.push(statusMessage);
    }

    const key = `a2a:task:${id}`;
    await this.redis.set(key, JSON.stringify(task), 'EX', this.ttlSeconds);

    return task;
  }

  /**
   * Link a contextId to a requestId for session-based flow auto-resolution.
   * Redis key: a2a:ctx:{contextId} -> requestId (TTL = ttlSeconds)
   */
  async setContextFlow(contextId: string, requestId: string): Promise<void> {
    await this.redis.set(`a2a:ctx:${contextId}`, requestId, 'EX', this.ttlSeconds);
  }

  /**
   * Get the requestId linked to a contextId.
   * Returns null if no flow is linked.
   */
  async getContextFlow(contextId: string): Promise<string | null> {
    return this.redis.get(`a2a:ctx:${contextId}`);
  }

  async addArtifact(id: string, artifact: Artifact): Promise<A2aTask> {
    const task = await this.getTask(id);

    if (!task) {
      throw new Error('Task not found');
    }

    if (!task.artifacts) task.artifacts = [];
    task.artifacts.push(artifact);

    const key = `a2a:task:${id}`;
    await this.redis.set(key, JSON.stringify(task), 'EX', this.ttlSeconds);

    return task;
  }
}
