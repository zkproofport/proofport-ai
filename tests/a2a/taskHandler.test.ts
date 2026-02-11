import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// Mock ioredis
vi.mock('ioredis', () => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    lpush: vi.fn().mockResolvedValue(1),
    quit: vi.fn(),
    status: 'ready',
  };
  return { default: vi.fn(() => mockRedis), Redis: vi.fn(() => mockRedis) };
});

import { createRedisClient, type RedisClient } from '../../src/redis/client.js';
import { TaskStore } from '../../src/a2a/taskStore.js';
import { createA2aHandler } from '../../src/a2a/taskHandler.js';

// ─── TaskStore (Redis-backed) ──────────────────────────────────────────────

describe('TaskStore', () => {
  let mockRedis: RedisClient;
  let store: TaskStore;

  beforeEach(() => {
    mockRedis = createRedisClient('redis://localhost:6379');
    vi.clearAllMocks();
    store = new TaskStore(mockRedis, 86400); // 24-hour TTL
  });

  it('1. createTask creates task with id, status:submitted, createdAt, stores in Redis', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const task = await store.createTask('generate_proof', { address: '0xabc', scope: 'test' });

    expect(task.id).toBeDefined();
    expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(task.status).toBe('submitted');
    expect(task.skill).toBe('generate_proof');
    expect(task.params).toEqual({ address: '0xabc', scope: 'test' });
    expect(task.createdAt).toBeDefined();
    expect(task.updatedAt).toBeDefined();
    expect(task.result).toBeUndefined();
    expect(task.error).toBeUndefined();

    expect(mockRedis.set).toHaveBeenCalledWith(
      `a2a:task:${task.id}`,
      expect.any(String),
      'EX',
      86400
    );
  });

  it('2. getTask returns task by ID from Redis', async () => {
    const storedTask = {
      id: 'test-id-123',
      status: 'submitted',
      skill: 'generate_proof',
      params: { address: '0xabc' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(storedTask));

    const task = await store.getTask('test-id-123');

    expect(task).toEqual(storedTask);
    expect(mockRedis.get).toHaveBeenCalledWith('a2a:task:test-id-123');
  });

  it('3. getTask returns null for non-existent task', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const task = await store.getTask('non-existent-id');

    expect(task).toBeNull();
  });

  it('4. updateTaskStatus transitions status correctly', async () => {
    const existingTask = {
      id: 'task-123',
      status: 'submitted' as const,
      skill: 'generate_proof',
      params: {},
      createdAt: '2026-02-10T12:00:00.000Z',
      updatedAt: '2026-02-10T12:00:00.000Z',
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(existingTask));
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const updated = await store.updateTaskStatus('task-123', 'working');

    expect(updated.status).toBe('working');
    expect(updated.updatedAt).not.toBe(existingTask.updatedAt);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(existingTask.updatedAt).getTime());
    expect(mockRedis.set).toHaveBeenCalledWith(
      'a2a:task:task-123',
      expect.any(String),
      'EX',
      86400
    );
  });

  it('5. updateTaskStatus validates transitions: submitted→working, working→completed, working→failed, submitted→canceled, working→canceled', async () => {
    // submitted → working (valid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({
      id: 'task-1',
      status: 'submitted',
      skill: 'generate_proof',
      params: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const task1 = await store.updateTaskStatus('task-1', 'working');
    expect(task1.status).toBe('working');

    // working → completed (valid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({
      id: 'task-2',
      status: 'working',
      skill: 'generate_proof',
      params: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const task2 = await store.updateTaskStatus('task-2', 'completed', { proof: '0xabc' });
    expect(task2.status).toBe('completed');
    expect(task2.result).toEqual({ proof: '0xabc' });

    // working → failed (valid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({
      id: 'task-3',
      status: 'working',
      skill: 'generate_proof',
      params: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const task3 = await store.updateTaskStatus('task-3', 'failed', undefined, 'Proof generation failed');
    expect(task3.status).toBe('failed');
    expect(task3.error).toBe('Proof generation failed');

    // submitted → canceled (valid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({
      id: 'task-4',
      status: 'submitted',
      skill: 'generate_proof',
      params: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const task4 = await store.updateTaskStatus('task-4', 'canceled');
    expect(task4.status).toBe('canceled');

    // working → canceled (valid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({
      id: 'task-5',
      status: 'working',
      skill: 'generate_proof',
      params: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const task5 = await store.updateTaskStatus('task-5', 'canceled');
    expect(task5.status).toBe('canceled');
  });

  it('6. updateTaskStatus rejects invalid transitions: completed→working, failed→submitted', async () => {
    // completed → working (invalid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({
      id: 'task-bad-1',
      status: 'completed',
      skill: 'generate_proof',
      params: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    await expect(store.updateTaskStatus('task-bad-1', 'working')).rejects.toThrow('Invalid status transition');

    // failed → submitted (invalid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({
      id: 'task-bad-2',
      status: 'failed',
      skill: 'generate_proof',
      params: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    await expect(store.updateTaskStatus('task-bad-2', 'submitted')).rejects.toThrow('Invalid status transition');
  });

  it('7. Task TTL: tasks expire in Redis after 24 hours (86400 seconds)', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    await store.createTask('generate_proof', {});

    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^a2a:task:/),
      expect.any(String),
      'EX',
      86400
    );
  });
});

// ─── JSON-RPC Handler ──────────────────────────────────────────────────────

describe('JSON-RPC Handler', () => {
  let mockRedis: RedisClient;
  let store: TaskStore;
  let handler: ReturnType<typeof createA2aHandler>;

  beforeEach(() => {
    mockRedis = createRedisClient('redis://localhost:6379');
    vi.clearAllMocks();
    store = new TaskStore(mockRedis, 86400);
    handler = createA2aHandler({ taskStore: store });
  });

  const createMockRequest = (body: unknown): Partial<Request> => ({
    body,
  });

  const createMockResponse = (): Partial<Response> => {
    const res: Partial<Response> = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    return res;
  };

  it('8. tasks/send creates new task, returns {jsonrpc, id, result: {id, status}}', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/send',
      params: {
        skill: 'generate_proof',
        address: '0xabc',
        scope: 'test',
      },
    });

    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 1,
      result: {
        id: expect.stringMatching(/^[0-9a-f-]+$/),
        status: 'submitted',
      },
    });
  });

  it('9. tasks/send requires params.skill field', async () => {
    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tasks/send',
      params: {
        address: '0xabc',
      },
    });

    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: -32602,
        message: 'Invalid params: skill is required',
      },
    });
  });

  it('10. tasks/send with invalid skill returns error code -32602', async () => {
    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tasks/send',
      params: {
        skill: 'invalid_skill',
      },
    });

    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 3,
      error: {
        code: -32602,
        message: expect.stringContaining('Invalid skill'),
      },
    });
  });

  it('11. tasks/get with valid task ID returns task with full status', async () => {
    const task = {
      id: 'task-123',
      status: 'completed' as const,
      skill: 'generate_proof',
      params: { address: '0xabc' },
      result: { proof: '0xproof' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(task));

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tasks/get',
      params: {
        id: 'task-123',
      },
    });

    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 4,
      result: task,
    });
  });

  it('12. tasks/get with non-existent ID returns error code -32001', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tasks/get',
      params: {
        id: 'non-existent',
      },
    });

    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 5,
      error: {
        code: -32001,
        message: 'Task not found',
      },
    });
  });

  it('13. tasks/cancel transitions task to canceled', async () => {
    const task = {
      id: 'task-456',
      status: 'submitted' as const,
      skill: 'generate_proof',
      params: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(task));
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tasks/cancel',
      params: {
        id: 'task-456',
      },
    });

    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 6,
      result: {
        id: 'task-456',
        status: 'canceled',
      },
    });
  });

  it('14. tasks/cancel on completed task returns error', async () => {
    const task = {
      id: 'task-789',
      status: 'completed' as const,
      skill: 'generate_proof',
      params: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(task));

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tasks/cancel',
      params: {
        id: 'task-789',
      },
    });

    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32002,
        message: expect.stringContaining('Invalid status transition'),
      },
    });
  });

  it('15. Unknown method returns error code -32601', async () => {
    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 8,
      method: 'unknown/method',
      params: {},
    });

    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 8,
      error: {
        code: -32601,
        message: 'Method not found',
      },
    });
  });

  it('16. Invalid JSON-RPC format returns -32600', async () => {
    // No jsonrpc field
    const req1 = createMockRequest({
      id: 9,
      method: 'tasks/send',
    });

    const res1 = createMockResponse();
    await handler(req1 as Request, res1 as Response, vi.fn());

    expect(res1.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 9,
      error: {
        code: -32600,
        message: expect.stringContaining('Invalid request'),
      },
    });

    // No method field
    const req2 = createMockRequest({
      jsonrpc: '2.0',
      id: 10,
    });

    const res2 = createMockResponse();
    await handler(req2 as Request, res2 as Response, vi.fn());

    expect(res2.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 10,
      error: {
        code: -32600,
        message: expect.stringContaining('Invalid request'),
      },
    });
  });
});
