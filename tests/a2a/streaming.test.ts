import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { TaskEventEmitter, attachSseStream } from '../../src/a2a/streaming.js';
import type { TaskStatus, Artifact, A2aTask } from '../../src/a2a/taskStore.js';
import type { Response } from 'express';

function createMockResponse(): any {
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

// ─── TaskEventEmitter ────────────────────────────────────────────────────

describe('TaskEventEmitter', () => {
  let emitter: TaskEventEmitter;

  beforeEach(() => {
    emitter = new TaskEventEmitter();
  });

  afterEach(() => {
    emitter.removeAllListeners();
  });

  it('emitStatusUpdate emits statusUpdate event with correct payload', () => {
    const taskId = 'task-123';
    const status: TaskStatus = { state: 'running', timestamp: new Date().toISOString() };

    return new Promise<void>((resolve) => {
      emitter.once(`task:${taskId}`, (event) => {
        expect(event.type).toBe('statusUpdate');
        expect(event.data.taskId).toBe(taskId);
        expect(event.data.status).toEqual(status);
        expect(event.data.final).toBe(false);
        resolve();
      });

      emitter.emitStatusUpdate(taskId, status, false);
    });
  });

  it('emitStatusUpdate with final=true sets final flag', () => {
    const taskId = 'task-final';
    const status: TaskStatus = { state: 'completed', timestamp: new Date().toISOString() };

    return new Promise<void>((resolve) => {
      emitter.once(`task:${taskId}`, (event) => {
        expect(event.type).toBe('statusUpdate');
        expect(event.data.final).toBe(true);
        resolve();
      });

      emitter.emitStatusUpdate(taskId, status, true);
    });
  });

  it('emitStatusUpdate with status message includes the message', () => {
    const taskId = 'task-msg';
    const status: TaskStatus = {
      state: 'running',
      message: {
        role: 'agent',
        parts: [{ kind: 'text', text: 'Constructing circuit parameters' }],
      },
      timestamp: new Date().toISOString(),
    };

    return new Promise<void>((resolve) => {
      emitter.once(`task:${taskId}`, (event) => {
        expect(event.data.status.message).toEqual(status.message);
        resolve();
      });

      emitter.emitStatusUpdate(taskId, status, false);
    });
  });

  it('emitArtifactUpdate emits artifactUpdate event with artifact data', () => {
    const taskId = 'task-abc';
    const artifact: Artifact = {
      id: 'art-1',
      mimeType: 'application/json',
      parts: [{ kind: 'data', mimeType: 'application/json', data: { proof: '0x123' } }],
    };

    return new Promise<void>((resolve) => {
      emitter.once(`task:${taskId}`, (event) => {
        expect(event.type).toBe('artifactUpdate');
        expect(event.data.taskId).toBe(taskId);
        expect(event.data.artifact).toEqual(artifact);
        resolve();
      });

      emitter.emitArtifactUpdate(taskId, artifact);
    });
  });

  it('emitTaskComplete emits task event with full A2aTask', () => {
    const taskId = 'task-complete';
    const task: A2aTask = {
      id: taskId,
      contextId: 'ctx-1',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      skill: 'generate_proof',
      params: {},
      history: [],
      artifacts: [],
      metadata: {},
      kind: 'task',
    };

    return new Promise<void>((resolve) => {
      emitter.once(`task:${taskId}`, (event) => {
        expect(event.type).toBe('task');
        expect(event.data).toEqual(task);
        resolve();
      });

      emitter.emitTaskComplete(taskId, task);
    });
  });

  it('multiple listeners receive the same event', () => {
    const taskId = 'task-multi';
    const status: TaskStatus = { state: 'completed', timestamp: new Date().toISOString() };
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

      emitter.emitStatusUpdate(taskId, status, false);
    });
  });

  it('listener for specific taskId only receives events for that task', () => {
    const taskId1 = 'task-001';
    const taskId2 = 'task-002';
    let task1Count = 0;
    let task2Count = 0;

    emitter.on(`task:${taskId1}`, () => { task1Count++; });
    emitter.on(`task:${taskId2}`, () => { task2Count++; });

    emitter.emitStatusUpdate(taskId1, { state: 'running', timestamp: new Date().toISOString() }, false);
    emitter.emitStatusUpdate(taskId2, { state: 'completed', timestamp: new Date().toISOString() }, true);

    expect(task1Count).toBe(1);
    expect(task2Count).toBe(1);
  });

  it('removeTaskListeners cleans up all listeners for a task', () => {
    const taskId = 'task-cleanup';
    let callCount = 0;

    emitter.on(`task:${taskId}`, () => { callCount++; });
    emitter.on(`task:${taskId}`, () => { callCount++; });

    emitter.emitStatusUpdate(taskId, { state: 'running', timestamp: new Date().toISOString() }, false);
    expect(callCount).toBe(2);

    emitter.removeTaskListeners(taskId);

    emitter.emitStatusUpdate(taskId, { state: 'completed', timestamp: new Date().toISOString() }, true);
    expect(callCount).toBe(2); // Still 2, not 4
  });
});

// ─── attachSseStream ────────────────────────────────────────────────────

describe('attachSseStream', () => {
  let emitter: TaskEventEmitter;

  beforeEach(() => {
    emitter = new TaskEventEmitter();
  });

  afterEach(() => {
    emitter.removeAllListeners();
  });

  it('sets correct SSE headers', () => {
    const res = createMockResponse();
    const taskId = 'task-headers';

    attachSseStream(res as Response, emitter, taskId, 'rpc-1');

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
  });

  it('sends initial keepalive comment on connect', () => {
    const res = createMockResponse();
    const taskId = 'task-keepalive';

    attachSseStream(res as Response, emitter, taskId, 'rpc-1');

    expect(res.write).toHaveBeenCalledWith(':keepalive\n\n');
  });

  it('forwards statusUpdate events as SSE with JSON-RPC envelope', () => {
    const res = createMockResponse();
    const taskId = 'task-status-sse';

    attachSseStream(res as Response, emitter, taskId, 42);
    res.write.mockClear();

    const status: TaskStatus = { state: 'running', timestamp: new Date().toISOString() };
    emitter.emitStatusUpdate(taskId, status, false);

    expect(res.write).toHaveBeenCalledTimes(1);
    const sseData = res.write.mock.calls[0][0] as string;

    expect(sseData).toContain('data: ');
    expect(sseData).toMatch(/\n\n$/);

    const jsonStr = sseData.replace(/^data: /, '').trim();
    const parsed = JSON.parse(jsonStr);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(42);
    expect(parsed.result.statusUpdate).toBeDefined();
    expect(parsed.result.statusUpdate.taskId).toBe(taskId);
    expect(parsed.result.statusUpdate.status).toEqual(status);
    expect(parsed.result.statusUpdate.final).toBe(false);
  });

  it('forwards artifactUpdate events as SSE with JSON-RPC envelope', () => {
    const res = createMockResponse();
    const taskId = 'task-artifact-sse';

    attachSseStream(res as Response, emitter, taskId, 'rpc-art');
    res.write.mockClear();

    const artifact: Artifact = {
      id: 'art-1',
      mimeType: 'application/json',
      parts: [{ kind: 'data', mimeType: 'application/json', data: { proof: '0x123' } }],
    };
    emitter.emitArtifactUpdate(taskId, artifact);

    const sseData = res.write.mock.calls[0][0] as string;
    const jsonStr = sseData.replace(/^data: /, '').trim();
    const parsed = JSON.parse(jsonStr);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe('rpc-art');
    expect(parsed.result.artifactUpdate).toBeDefined();
    expect(parsed.result.artifactUpdate.artifact).toEqual(artifact);
  });

  it('closes stream on task complete event', () => {
    const res = createMockResponse();
    const taskId = 'task-close';

    attachSseStream(res as Response, emitter, taskId, 'rpc-close');
    res.write.mockClear();

    const task: A2aTask = {
      id: taskId,
      contextId: 'ctx-1',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      skill: 'generate_proof',
      params: {},
      history: [],
      artifacts: [],
      metadata: {},
      kind: 'task',
    };
    emitter.emitTaskComplete(taskId, task);

    // Write was called with the task event data
    expect(res.write).toHaveBeenCalled();
    // Stream was closed
    expect(res.end).toHaveBeenCalled();
  });

  it('does not close stream on non-task events', () => {
    const res = createMockResponse();
    const taskId = 'task-no-close';

    attachSseStream(res as Response, emitter, taskId, 'rpc-nc');
    res.write.mockClear();

    emitter.emitStatusUpdate(taskId, { state: 'running', timestamp: new Date().toISOString() }, false);

    expect(res.write).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('cleans up listener on client disconnect', () => {
    const res = createMockResponse();
    const taskId = 'task-disconnect';

    attachSseStream(res as Response, emitter, taskId, 'rpc-dc');

    expect(emitter.listenerCount(`task:${taskId}`)).toBe(1);

    // Simulate client disconnect
    res.emit('close');

    expect(emitter.listenerCount(`task:${taskId}`)).toBe(0);
  });

  it('does not forward events from other tasks', () => {
    const res = createMockResponse();
    const taskId = 'task-isolation';
    const otherTaskId = 'other-task';

    attachSseStream(res as Response, emitter, taskId, 'rpc-iso');
    res.write.mockClear();

    emitter.emitStatusUpdate(otherTaskId, { state: 'running', timestamp: new Date().toISOString() }, false);

    expect(res.write).not.toHaveBeenCalled();
  });

  it('uses string jsonRpcId in envelope', () => {
    const res = createMockResponse();
    const taskId = 'task-str-id';

    attachSseStream(res as Response, emitter, taskId, 'string-id-99');
    res.write.mockClear();

    emitter.emitStatusUpdate(taskId, { state: 'running', timestamp: new Date().toISOString() }, false);

    const sseData = res.write.mock.calls[0][0] as string;
    const jsonStr = sseData.replace(/^data: /, '').trim();
    const parsed = JSON.parse(jsonStr);

    expect(parsed.id).toBe('string-id-99');
  });
});
