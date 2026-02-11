import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { TaskEventEmitter, createStreamHandler } from '../../src/a2a/streaming';

// Mock Express request/response objects for SSE testing
function createMockResponse() {
  const res: any = new EventEmitter();
  res.writeHead = vi.fn();
  res.write = vi.fn();
  res.end = vi.fn();
  res.setHeader = vi.fn();
  res.headersSent = false;
  res.statusCode = 200;
  res.status = vi.fn().mockReturnThis();
  res.json = vi.fn();
  return res;
}

function createMockRequest(params: Record<string, string> = {}) {
  const req: any = new EventEmitter();
  req.params = params;
  return req;
}

describe('TaskEventEmitter', () => {
  let emitter: TaskEventEmitter;

  beforeEach(() => {
    emitter = new TaskEventEmitter();
  });

  afterEach(() => {
    emitter.removeAllListeners();
  });

  it('emitTaskStatus emits task.status event with correct payload', () => {
    const taskId = 'task-123';
    const status = 'working';

    return new Promise<void>((resolve) => {
      emitter.once(`task:${taskId}`, (event) => {
        expect(event.type).toBe('task.status');
        expect(event.taskId).toBe(taskId);
        expect(event.status).toBe(status);
        expect(event.timestamp).toBeDefined();
        expect(new Date(event.timestamp).getTime()).toBeGreaterThan(0);
        resolve();
      });

      emitter.emitTaskStatus(taskId, status);
    });
  });

  it('emitTaskProgress emits task.progress event with step and detail', () => {
    const taskId = 'task-456';
    const step = 'fetching_attestation';
    const detail = 'Querying EAS GraphQL endpoint';

    return new Promise<void>((resolve) => {
      emitter.once(`task:${taskId}`, (event) => {
        expect(event.type).toBe('task.progress');
        expect(event.taskId).toBe(taskId);
        expect(event.step).toBe(step);
        expect(event.detail).toBe(detail);
        expect(event.timestamp).toBeDefined();
        resolve();
      });

      emitter.emitTaskProgress(taskId, step, detail);
    });
  });

  it('emitTaskProgress works without optional detail parameter', () => {
    const taskId = 'task-789';
    const step = 'building_witness';

    return new Promise<void>((resolve) => {
      emitter.once(`task:${taskId}`, (event) => {
        expect(event.type).toBe('task.progress');
        expect(event.taskId).toBe(taskId);
        expect(event.step).toBe(step);
        expect(event.detail).toBeUndefined();
        expect(event.timestamp).toBeDefined();
        resolve();
      });

      emitter.emitTaskProgress(taskId, step);
    });
  });

  it('emitTaskArtifact emits task.artifact event with artifact data', () => {
    const taskId = 'task-abc';
    const artifact = {
      proof: '0x123456',
      publicInputs: ['0xabc', '0xdef'],
      nullifier: '0x789',
    };

    return new Promise<void>((resolve) => {
      emitter.once(`task:${taskId}`, (event) => {
        expect(event.type).toBe('task.artifact');
        expect(event.taskId).toBe(taskId);
        expect(event.artifact).toEqual(artifact);
        expect(event.timestamp).toBeDefined();
        resolve();
      });

      emitter.emitTaskArtifact(taskId, artifact);
    });
  });

  it('multiple listeners receive the same event', () => {
    const taskId = 'task-multi';
    const status = 'completed';
    let receivedCount = 0;

    return new Promise<void>((resolve) => {
      const listener1 = () => {
        receivedCount++;
        if (receivedCount === 2) resolve();
      };

      const listener2 = () => {
        receivedCount++;
        if (receivedCount === 2) resolve();
      };

      emitter.on(`task:${taskId}`, listener1);
      emitter.on(`task:${taskId}`, listener2);

      emitter.emitTaskStatus(taskId, status);
    });
  });

  it('listener for specific taskId only receives events for that task', () => {
    const taskId1 = 'task-001';
    const taskId2 = 'task-002';
    let task1Count = 0;
    let task2Count = 0;

    emitter.on(`task:${taskId1}`, () => {
      task1Count++;
    });

    emitter.on(`task:${taskId2}`, () => {
      task2Count++;
    });

    emitter.emitTaskStatus(taskId1, 'working');
    emitter.emitTaskStatus(taskId2, 'completed');

    // EventEmitter is synchronous, no need for setTimeout
    expect(task1Count).toBe(1);
    expect(task2Count).toBe(1);
  });

  it('removeTaskListeners cleans up all listeners for a task', () => {
    const taskId = 'task-cleanup';
    let callCount = 0;

    emitter.on(`task:${taskId}`, () => {
      callCount++;
    });

    emitter.on(`task:${taskId}`, () => {
      callCount++;
    });

    // Emit event - should trigger both listeners
    emitter.emitTaskStatus(taskId, 'working');
    expect(callCount).toBe(2);

    // Clean up listeners
    emitter.removeTaskListeners(taskId);

    // Emit again - should not trigger any listeners
    emitter.emitTaskStatus(taskId, 'completed');
    expect(callCount).toBe(2); // Still 2, not 4
  });
});

describe('SSE Handler', () => {
  let emitter: TaskEventEmitter;

  beforeEach(() => {
    emitter = new TaskEventEmitter();
  });

  afterEach(() => {
    emitter.removeAllListeners();
  });

  it('createStreamHandler returns Express RequestHandler', () => {
    const handler = createStreamHandler(emitter);
    expect(typeof handler).toBe('function');
    expect(handler.length).toBe(3); // (req, res, next)
  });

  it('handler sets correct SSE headers', async () => {
    const handler = createStreamHandler(emitter);
    const req = createMockRequest({ taskId: 'task-headers' });
    const res = createMockResponse();
    const next = vi.fn();

    handler(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
  });

  it('handler sends initial keepalive comment on connect', async () => {
    const handler = createStreamHandler(emitter);
    const req = createMockRequest({ taskId: 'task-keepalive' });
    const res = createMockResponse();
    const next = vi.fn();

    handler(req, res, next);

    expect(res.write).toHaveBeenCalledWith(':keepalive\n\n');
  });

  it('handler forwards task.status events as SSE format', () => {
    const handler = createStreamHandler(emitter);
    const taskId = 'task-status-sse';
    const req = createMockRequest({ taskId });
    const res = createMockResponse();
    const next = vi.fn();

    handler(req, res, next);
    res.write.mockClear();

    emitter.emitTaskStatus(taskId, 'working');

    expect(res.write).toHaveBeenCalled();
    const sseData = res.write.mock.calls[0][0];

    expect(sseData).toContain('event: task.status\n');
    expect(sseData).toContain('data: ');
    expect(sseData).toContain(taskId);
    expect(sseData).toContain('working');
    expect(sseData).toContain('timestamp');
    expect(sseData).toMatch(/\n\n$/);
  });

  it('handler forwards task.progress events as SSE format', () => {
    const handler = createStreamHandler(emitter);
    const taskId = 'task-progress-sse';
    const req = createMockRequest({ taskId });
    const res = createMockResponse();
    const next = vi.fn();

    handler(req, res, next);
    res.write.mockClear();

    emitter.emitTaskProgress(taskId, 'generating_proof', 'Computing witness');

    const sseData = res.write.mock.calls[0][0];
    expect(sseData).toContain('event: task.progress\n');
    expect(sseData).toContain('data: ');
    expect(sseData).toContain('generating_proof');
    expect(sseData).toContain('Computing witness');
  });

  it('handler forwards task.artifact events as SSE format', () => {
    const handler = createStreamHandler(emitter);
    const taskId = 'task-artifact-sse';
    const req = createMockRequest({ taskId });
    const res = createMockResponse();
    const next = vi.fn();

    handler(req, res, next);
    res.write.mockClear();

    const artifact = {
      proof: '0x123',
      publicInputs: ['0xabc'],
    };

    emitter.emitTaskArtifact(taskId, artifact);

    const sseData = res.write.mock.calls[0][0];
    expect(sseData).toContain('event: task.artifact\n');
    expect(sseData).toContain('data: ');
    expect(sseData).toContain('0x123');
    expect(sseData).toContain('0xabc');
  });

  it('handler cleans up listeners on client disconnect', () => {
    const handler = createStreamHandler(emitter);
    const taskId = 'task-disconnect';
    const req = createMockRequest({ taskId });
    const res = createMockResponse();
    const next = vi.fn();

    handler(req, res, next);

    expect(emitter.listenerCount(`task:${taskId}`)).toBe(1);

    // Simulate client disconnect
    res.emit('close');

    expect(emitter.listenerCount(`task:${taskId}`)).toBe(0);
  });

  it('handler returns 404 if taskId param is missing', () => {
    const handler = createStreamHandler(emitter);
    const req = createMockRequest({}); // No taskId
    const res = createMockResponse();
    const next = vi.fn();

    handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Task ID is required' });
    expect(res.setHeader).not.toHaveBeenCalled(); // No SSE headers set
  });

  it('handler does not forward events from other tasks', () => {
    const handler = createStreamHandler(emitter);
    const taskId = 'task-isolation';
    const otherTaskId = 'other-task';
    const req = createMockRequest({ taskId });
    const res = createMockResponse();
    const next = vi.fn();

    handler(req, res, next);
    res.write.mockClear();

    // Emit event for OTHER task
    emitter.emitTaskStatus(otherTaskId, 'working');

    // Should not have received any writes (only keepalive was sent before clear)
    expect(res.write).not.toHaveBeenCalled();
  });
});
