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
import { TaskStore, type A2aTask, type Message } from '../../src/a2a/taskStore.js';
import { TaskEventEmitter } from '../../src/a2a/streaming.js';
import { createA2aHandler } from '../../src/a2a/taskHandler.js';

// ─── TaskStore (Redis-backed) ──────────────────────────────────────────────

describe('TaskStore', () => {
  let mockRedis: RedisClient;
  let store: TaskStore;

  beforeEach(() => {
    mockRedis = createRedisClient('redis://localhost:6379');
    vi.clearAllMocks();
    store = new TaskStore(mockRedis, 86400);
  });

  it('1. createTask creates task with id, status:{state:"queued"}, stores in Redis', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const userMessage: Message = {
      role: 'user',
      parts: [{ kind: 'data', mimeType: 'application/json', data: { skill: 'generate_proof', address: '0xabc', scope: 'test' } }],
    };

    const task = await store.createTask('generate_proof', { address: '0xabc', scope: 'test' }, userMessage);

    expect(task.id).toBeDefined();
    expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(task.status).toEqual({ state: 'queued', timestamp: expect.any(String) });
    expect(task.skill).toBe('generate_proof');
    expect(task.params).toEqual({ address: '0xabc', scope: 'test' });
    expect(task.contextId).toBeDefined();
    expect(task.history).toEqual([userMessage]);
    expect(task.artifacts).toEqual([]);
    expect(task.metadata).toEqual({});
    expect(task.kind).toBe('task');

    expect(mockRedis.set).toHaveBeenCalledWith(
      `a2a:task:${task.id}`,
      expect.any(String),
      'EX',
      86400
    );
  });

  it('2. createTask pushes task ID to a2a:queue:submitted', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const userMessage: Message = {
      role: 'user',
      parts: [{ kind: 'data', mimeType: 'application/json', data: { skill: 'generate_proof' } }],
    };

    const task = await store.createTask('generate_proof', {}, userMessage);

    expect(mockRedis.lpush).toHaveBeenCalledWith('a2a:queue:submitted', task.id);
  });

  it('3. createTask uses provided contextId when given', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const userMessage: Message = {
      role: 'user',
      parts: [{ kind: 'text', text: 'generate proof' }],
    };

    const task = await store.createTask('generate_proof', {}, userMessage, 'custom-context-id');

    expect(task.contextId).toBe('custom-context-id');
  });

  it('4. getTask returns task by ID from Redis', async () => {
    const storedTask: A2aTask = {
      id: 'test-id-123',
      contextId: 'ctx-1',
      status: { state: 'queued', timestamp: new Date().toISOString() },
      skill: 'generate_proof',
      params: { address: '0xabc' },
      history: [],
      artifacts: [],
      metadata: {},
      kind: 'task',
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(storedTask));

    const task = await store.getTask('test-id-123');

    expect(task).toEqual(storedTask);
    expect(mockRedis.get).toHaveBeenCalledWith('a2a:task:test-id-123');
  });

  it('5. getTask returns null for non-existent task', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const task = await store.getTask('non-existent-id');

    expect(task).toBeNull();
  });

  it('6. updateTaskStatus transitions status correctly (queued -> running)', async () => {
    const existingTask: A2aTask = {
      id: 'task-123',
      contextId: 'ctx-1',
      status: { state: 'queued', timestamp: '2026-02-10T12:00:00.000Z' },
      skill: 'generate_proof',
      params: {},
      history: [],
      artifacts: [],
      metadata: {},
      kind: 'task',
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(existingTask));
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const updated = await store.updateTaskStatus('task-123', 'running');

    expect(updated.status.state).toBe('running');
    expect(updated.status.timestamp).toBeDefined();
    expect(new Date(updated.status.timestamp!).getTime()).toBeGreaterThan(
      new Date(existingTask.status.timestamp!).getTime()
    );
    expect(mockRedis.set).toHaveBeenCalledWith(
      'a2a:task:task-123',
      expect.any(String),
      'EX',
      86400
    );
  });

  it('7. updateTaskStatus with statusMessage appends to history', async () => {
    const existingTask: A2aTask = {
      id: 'task-msg',
      contextId: 'ctx-1',
      status: { state: 'running', timestamp: '2026-02-10T12:00:00.000Z' },
      skill: 'generate_proof',
      params: {},
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'go' }] }],
      artifacts: [],
      metadata: {},
      kind: 'task',
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(existingTask));
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const statusMessage: Message = { role: 'agent', parts: [{ kind: 'text', text: 'done' }] };
    const updated = await store.updateTaskStatus('task-msg', 'completed', statusMessage);

    expect(updated.status.state).toBe('completed');
    expect(updated.status.message).toEqual(statusMessage);
    expect(updated.history).toHaveLength(2);
    expect(updated.history![1]).toEqual(statusMessage);
  });

  it('8. updateTaskStatus validates transitions: queued->running, running->completed, running->failed, queued->canceled, running->canceled', async () => {
    const makeTask = (id: string, state: string): A2aTask => ({
      id,
      contextId: 'ctx-1',
      status: { state: state as any, timestamp: new Date().toISOString() },
      skill: 'generate_proof',
      params: {},
      history: [],
      artifacts: [],
      metadata: {},
      kind: 'task',
    });

    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    // queued -> running (valid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(makeTask('t1', 'queued')));
    const t1 = await store.updateTaskStatus('t1', 'running');
    expect(t1.status.state).toBe('running');

    // running -> completed (valid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(makeTask('t2', 'running')));
    const t2 = await store.updateTaskStatus('t2', 'completed');
    expect(t2.status.state).toBe('completed');

    // running -> failed (valid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(makeTask('t3', 'running')));
    const t3 = await store.updateTaskStatus('t3', 'failed');
    expect(t3.status.state).toBe('failed');

    // queued -> canceled (valid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(makeTask('t4', 'queued')));
    const t4 = await store.updateTaskStatus('t4', 'canceled');
    expect(t4.status.state).toBe('canceled');

    // running -> canceled (valid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(makeTask('t5', 'running')));
    const t5 = await store.updateTaskStatus('t5', 'canceled');
    expect(t5.status.state).toBe('canceled');
  });

  it('9. updateTaskStatus rejects invalid transitions: completed->running, failed->queued', async () => {
    const makeTask = (id: string, state: string): A2aTask => ({
      id,
      contextId: 'ctx-1',
      status: { state: state as any, timestamp: new Date().toISOString() },
      skill: 'generate_proof',
      params: {},
      history: [],
      artifacts: [],
      metadata: {},
      kind: 'task',
    });

    // completed -> running (invalid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(makeTask('bad-1', 'completed')));
    await expect(store.updateTaskStatus('bad-1', 'running')).rejects.toThrow('Invalid status transition');

    // failed -> queued (invalid)
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(makeTask('bad-2', 'failed')));
    await expect(store.updateTaskStatus('bad-2', 'queued')).rejects.toThrow('Invalid status transition');
  });

  it('10. updateTaskStatus throws for non-existent task', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(store.updateTaskStatus('missing', 'running')).rejects.toThrow('Task not found');
  });

  it('11. addArtifact appends artifact to task', async () => {
    const existingTask: A2aTask = {
      id: 'task-art',
      contextId: 'ctx-1',
      status: { state: 'running', timestamp: new Date().toISOString() },
      skill: 'generate_proof',
      params: {},
      history: [],
      artifacts: [],
      metadata: {},
      kind: 'task',
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(existingTask));
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const artifact = {
      id: 'art-1',
      mimeType: 'application/json',
      parts: [{ kind: 'data' as const, mimeType: 'application/json', data: { proof: '0x123' } }],
    };

    const updated = await store.addArtifact('task-art', artifact);

    expect(updated.artifacts).toHaveLength(1);
    expect(updated.artifacts![0]).toEqual(artifact);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'a2a:task:task-art',
      expect.any(String),
      'EX',
      86400
    );
  });

  it('12. addArtifact throws for non-existent task', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(store.addArtifact('missing', { id: 'a', mimeType: 'text/plain', parts: [] })).rejects.toThrow('Task not found');
  });

  it('13. Task TTL: tasks expire in Redis after 24 hours (86400 seconds)', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const userMessage: Message = {
      role: 'user',
      parts: [{ kind: 'text', text: 'test' }],
    };
    await store.createTask('generate_proof', {}, userMessage);

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
  let emitter: TaskEventEmitter;
  let handler: ReturnType<typeof createA2aHandler>;

  beforeEach(() => {
    mockRedis = createRedisClient('redis://localhost:6379');
    vi.clearAllMocks();
    store = new TaskStore(mockRedis, 86400);
    emitter = new TaskEventEmitter();
    handler = createA2aHandler({ taskStore: store, taskEventEmitter: emitter });
  });

  const createMockRequest = (body: unknown): Partial<Request> => ({
    body,
  });

  const createMockResponse = (): Partial<Response> & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn> } => {
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      write: vi.fn(),
      end: vi.fn(),
      setHeader: vi.fn(),
      on: vi.fn(),
    };
    return res;
  };

  // --- message/send validation tests (these error paths return immediately, no blocking) ---

  it('1. message/send with missing message returns -32602', async () => {
    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {},
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32602,
        message: expect.stringContaining('message with role and non-empty parts is required'),
      },
    });
  });

  it('2. message/send with empty parts returns -32602', async () => {
    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'message/send',
      params: {
        message: { role: 'user', parts: [] },
      },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: -32602,
        message: expect.stringContaining('message with role and non-empty parts is required'),
      },
    });
  });

  it('3. message/send with message that cannot determine skill returns -32602', async () => {
    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [{ kind: 'text', text: 'hello world nothing relevant' }],
        },
      },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 3,
      error: {
        code: -32602,
        message: expect.stringContaining('Could not determine skill'),
      },
    });
  });

  it('4. message/send with invalid skill in DataPart returns -32602', async () => {
    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [{ kind: 'data', mimeType: 'application/json', data: { skill: 'invalid_skill' } }],
        },
      },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 4,
      error: {
        code: -32602,
        message: expect.stringContaining('Invalid skill: invalid_skill'),
      },
    });
  });

  // --- message/stream tests (non-blocking, sets up SSE) ---

  it('5. message/stream with valid DataPart creates task and attaches SSE', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'message/stream',
      params: {
        message: {
          role: 'user',
          parts: [{ kind: 'data', mimeType: 'application/json', data: { skill: 'generate_proof', address: '0xabc' } }],
        },
      },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    // SSE headers should be set
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.write).toHaveBeenCalledWith(':keepalive\n\n');

    // Task should have been created in Redis
    expect(mockRedis.set).toHaveBeenCalled();
    expect(mockRedis.lpush).toHaveBeenCalledWith('a2a:queue:submitted', expect.any(String));
  });

  it('6. message/stream extracts skill from text part (proof keyword)', async () => {
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'message/stream',
      params: {
        message: {
          role: 'user',
          parts: [{ kind: 'text', text: 'I want to generate a proof' }],
        },
      },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    // Should succeed (SSE headers set)
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
  });

  it('7. message/stream with invalid message returns -32602 (no SSE)', async () => {
    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'message/stream',
      params: {
        message: { role: 'user', parts: [] },
      },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32602,
        message: expect.stringContaining('message with role and non-empty parts is required'),
      },
    });
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  // --- tasks/get ---

  it('8. tasks/get with valid task ID returns full A2aTask', async () => {
    const task: A2aTask = {
      id: 'task-123',
      contextId: 'ctx-1',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      skill: 'generate_proof',
      params: { address: '0xabc' },
      history: [{ role: 'user', parts: [{ kind: 'text', text: 'go' }] }],
      artifacts: [{
        id: 'art-1',
        mimeType: 'application/json',
        parts: [{ kind: 'data', mimeType: 'application/json', data: { proof: '0xproof' } }],
      }],
      metadata: {},
      kind: 'task',
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(task));

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 8,
      method: 'tasks/get',
      params: { id: 'task-123' },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 8,
      result: task,
    });
  });

  it('9. tasks/get with historyLength parameter trims history', async () => {
    const task: A2aTask = {
      id: 'task-hist',
      contextId: 'ctx-1',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      skill: 'generate_proof',
      params: {},
      history: [
        { role: 'user', parts: [{ kind: 'text', text: 'msg1' }] },
        { role: 'agent', parts: [{ kind: 'text', text: 'msg2' }] },
        { role: 'agent', parts: [{ kind: 'text', text: 'msg3' }] },
      ],
      artifacts: [],
      metadata: {},
      kind: 'task',
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(task));

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 9,
      method: 'tasks/get',
      params: { id: 'task-hist', historyLength: 1 },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.result.history).toHaveLength(1);
    expect(call.result.history[0].parts[0].text).toBe('msg3');
  });

  it('10. tasks/get with non-existent ID returns error code -32001', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'tasks/get',
      params: { id: 'non-existent' },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 10,
      error: {
        code: -32001,
        message: 'Task not found',
      },
    });
  });

  it('11. tasks/get without id param returns -32602', async () => {
    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'tasks/get',
      params: {},
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 11,
      error: {
        code: -32602,
        message: expect.stringContaining('id is required'),
      },
    });
  });

  // --- tasks/cancel ---

  it('12. tasks/cancel transitions queued task to canceled, returns full A2aTask', async () => {
    const task: A2aTask = {
      id: 'task-456',
      contextId: 'ctx-1',
      status: { state: 'queued', timestamp: new Date().toISOString() },
      skill: 'generate_proof',
      params: {},
      history: [],
      artifacts: [],
      metadata: {},
      kind: 'task',
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(task));
    (mockRedis.set as ReturnType<typeof vi.fn>).mockResolvedValue('OK');

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tasks/cancel',
      params: { id: 'task-456' },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.jsonrpc).toBe('2.0');
    expect(call.id).toBe(12);
    expect(call.result.id).toBe('task-456');
    expect(call.result.status.state).toBe('canceled');
    expect(call.result.kind).toBe('task');
  });

  it('13. tasks/cancel on completed task returns error -32002', async () => {
    const task: A2aTask = {
      id: 'task-789',
      contextId: 'ctx-1',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      skill: 'generate_proof',
      params: {},
      history: [],
      artifacts: [],
      metadata: {},
      kind: 'task',
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(task));

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'tasks/cancel',
      params: { id: 'task-789' },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 13,
      error: {
        code: -32002,
        message: expect.stringContaining('Invalid status transition'),
      },
    });
  });

  it('14. tasks/cancel on non-existent task returns -32001', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 14,
      method: 'tasks/cancel',
      params: { id: 'non-existent' },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 14,
      error: {
        code: -32001,
        message: 'Task not found',
      },
    });
  });

  // --- tasks/resubscribe ---

  it('15. tasks/resubscribe on terminal task returns task directly (no SSE)', async () => {
    const task: A2aTask = {
      id: 'task-resub-done',
      contextId: 'ctx-1',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      skill: 'generate_proof',
      params: {},
      history: [],
      artifacts: [],
      metadata: {},
      kind: 'task',
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(task));

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 15,
      method: 'tasks/resubscribe',
      params: { id: 'task-resub-done' },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 15,
      result: task,
    });
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('16. tasks/resubscribe on running task attaches SSE stream', async () => {
    const task: A2aTask = {
      id: 'task-resub-running',
      contextId: 'ctx-1',
      status: { state: 'running', timestamp: new Date().toISOString() },
      skill: 'generate_proof',
      params: {},
      history: [],
      artifacts: [],
      metadata: {},
      kind: 'task',
    };

    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(task));

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 16,
      method: 'tasks/resubscribe',
      params: { id: 'task-resub-running' },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.write).toHaveBeenCalledWith(':keepalive\n\n');
  });

  it('17. tasks/resubscribe with non-existent task returns -32001', async () => {
    (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 17,
      method: 'tasks/resubscribe',
      params: { id: 'missing' },
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 17,
      error: {
        code: -32001,
        message: 'Task not found',
      },
    });
  });

  // --- Unknown method, invalid JSON-RPC ---

  it('18. Unknown method returns error code -32601 with method name', async () => {
    const req = createMockRequest({
      jsonrpc: '2.0',
      id: 18,
      method: 'unknown/method',
      params: {},
    });
    const res = createMockResponse();

    await handler(req as Request, res as Response, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 18,
      error: {
        code: -32601,
        message: 'Method not found: unknown/method',
      },
    });
  });

  it('19. Invalid JSON-RPC format returns -32600', async () => {
    // No jsonrpc field
    const req1 = createMockRequest({
      id: 19,
      method: 'message/send',
    });
    const res1 = createMockResponse();
    await handler(req1 as Request, res1 as Response, vi.fn());

    expect(res1.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 19,
      error: {
        code: -32600,
        message: expect.stringContaining('Invalid request'),
      },
    });

    // No method field
    const req2 = createMockRequest({
      jsonrpc: '2.0',
      id: 20,
    });
    const res2 = createMockResponse();
    await handler(req2 as Request, res2 as Response, vi.fn());

    expect(res2.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 20,
      error: {
        code: -32600,
        message: expect.stringContaining('Invalid request'),
      },
    });
  });
});
