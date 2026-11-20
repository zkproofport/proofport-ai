import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCard, Message, Task } from '@a2a-js/sdk';
import {
  A2AError,
  DefaultRequestHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
} from '@a2a-js/sdk/server';

const logged = vi.hoisted(() => ({ error: [] as unknown[][], warn: [] as unknown[][] }));
vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => logged.error.push(args),
    warn: (...args: unknown[]) => logged.warn.push(args),
    info: () => {},
    debug: () => {},
  }),
}));

import {
  createGuardedRequestHandler,
  GuardedTaskStore,
  MAX_REMEMBERED_FAILED_TASKS,
} from '../../src/a2a/taskStoreGuard.js';

/**
 * A Redis write failure used to end the process: the SDK's event loop hands a
 * store error to an un-awaited async function that rethrows it. These tests
 * run the REAL DefaultRequestHandler (the SDK this server ships with) over a
 * store that fails on demand.
 */

const card = {
  name: 'test', description: 'test', url: 'http://localhost/a2a', version: '1',
  protocolVersion: '0.3.0', capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['text'], defaultOutputModes: ['text'], skills: [],
} as unknown as AgentCard;

/** Publishes a task, a working status, then a final completed status. */
class ThreeStepExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const task: Task = {
      id: ctx.taskId, contextId: ctx.contextId, kind: 'task',
      status: { state: 'submitted', timestamp: new Date().toISOString() },
      history: [ctx.userMessage],
    };
    bus.publish(task);
    await new Promise((r) => setTimeout(r, 5));
    bus.publish({ kind: 'status-update', taskId: ctx.taskId, contextId: ctx.contextId, final: false,
      status: { state: 'working', timestamp: new Date().toISOString() } });
    await new Promise((r) => setTimeout(r, 5));
    bus.publish({ kind: 'status-update', taskId: ctx.taskId, contextId: ctx.contextId, final: true,
      status: { state: 'completed', timestamp: new Date().toISOString() } });
    bus.finished();
  }
  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    bus.publish({ kind: 'status-update', taskId, contextId: 'ctx', final: true,
      status: { state: 'canceled', timestamp: new Date().toISOString() } });
    bus.finished();
  }
}

/** In-memory store whose save/load fail when told to. `failSaveAfter` = saves that succeed first. */
class FlakyStore implements TaskStore {
  readonly tasks = new Map<string, Task>();
  saves = 0;
  failSaveAfter = Infinity;
  failLoad = false;
  /** Loads that succeed before every later one fails. */
  failLoadAfter = Infinity;
  loads = 0;
  async save(task: Task): Promise<void> {
    this.saves += 1;
    if (this.saves > this.failSaveAfter) {
      throw new Error("MISCONF Redis is configured to save RDB snapshots, but it's currently unable to persist to disk.");
    }
    this.tasks.set(task.id, structuredClone(task));
  }
  async load(taskId: string): Promise<Task | undefined> {
    this.loads += 1;
    if (this.failLoad || this.loads > this.failLoadAfter) throw new Error('connect ECONNREFUSED');
    const t = this.tasks.get(taskId);
    return t ? structuredClone(t) : undefined;
  }
}

/** Runs until cancelled, so tasks/cancel finds a live event bus and runs the SDK's event loop. */
class RunsUntilCancelled implements AgentExecutor {
  private stop: (() => void) | undefined;
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    bus.publish({ id: ctx.taskId, contextId: ctx.contextId, kind: 'task',
      status: { state: 'working', timestamp: new Date().toISOString() }, history: [ctx.userMessage] });
    await new Promise<void>((resolve) => { this.stop = resolve; });
  }
  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    bus.publish({ kind: 'status-update', taskId, contextId: 'ctx', final: true,
      status: { state: 'canceled', timestamp: new Date().toISOString() } });
    bus.finished();
    this.stop?.();
  }
}

function message(id: string, taskId?: string): Message {
  return { kind: 'message', role: 'user', messageId: id, parts: [{ kind: 'text', text: 'hello' }], ...(taskId && { taskId }) };
}

function build(store: TaskStore) {
  return createGuardedRequestHandler(store, (s) => new DefaultRequestHandler(card, s, new ThreeStepExecutor()));
}

/** Let every pending timer, microtask and floating promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 60));

let unhandled: unknown[];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
  unhandled = [];
  logged.error.length = 0;
  logged.warn.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  await settle();
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled, 'a task-store failure escaped as an unhandled rejection').toEqual([]);
});

function loggedActions(): string[] {
  return logged.error.map((args) => (args[0] as { action: string }).action);
}

describe('healthy store: behaviour unchanged', () => {
  it('a blocking send answers with the completed task and logs nothing', async () => {
    const inner = new FlakyStore();
    const { handler } = build(inner);
    const result = await handler.sendMessage({ message: message('m1') });
    expect(result.kind).toBe('task');
    expect((result as Task).status.state).toBe('completed');
    expect(inner.tasks.get((result as Task).id)?.status.state).toBe('completed');
    expect(logged.error).toEqual([]);
  });

  it('getTask returns the stored task as stored', async () => {
    const inner = new FlakyStore();
    const { handler } = build(inner);
    const sent = (await handler.sendMessage({ message: message('m1') })) as Task;
    const got = await handler.getTask({ id: sent.id });
    expect(got.status.state).toBe('completed');
  });

  it('a stream yields every event and ends normally', async () => {
    const { handler } = build(new FlakyStore());
    const kinds: string[] = [];
    for await (const e of handler.sendMessageStream({ message: message('m1') })) kinds.push(e.kind);
    expect(kinds).toEqual(['task', 'status-update', 'status-update']);
  });
});

describe('save fails on the awaited (blocking) path', () => {
  it('the caller gets an error naming the storage failure, never the task as a success', async () => {
    const inner = new FlakyStore();
    inner.failSaveAfter = 0;
    const { handler } = build(inner);
    const err = await handler.sendMessage({ message: message('m1') }).then(
      () => { throw new Error('resolved'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(A2AError);
    expect((err as A2AError).code).toBe(-32603);
    expect((err as Error).message).toMatch(/^Task storage failed \(save of task [0-9a-f-]{36}\); the request did not complete\. Send it again\.$/);
    // The store's own message names the backing service; it goes to the log only.
    expect((err as Error).message).not.toContain('MISCONF');
    expect((err as Error).message).not.toContain('Redis');
  });

  it('a save failing after the first one (the final status) is still an error to the caller', async () => {
    const inner = new FlakyStore();
    inner.failSaveAfter = 2; // task + working stored, completed is not
    const { handler } = build(inner);
    await expect(handler.sendMessage({ message: message('m1') })).rejects.toThrow('Task storage failed');
    // The stored copy said "working"; one attempt marked it failed.
    const [stored] = [...inner.tasks.values()];
    expect(stored.status.state).toBe('working');
  });

  it('logs every failed save in full (message and stack), with the task id', async () => {
    const inner = new FlakyStore();
    inner.failSaveAfter = 0;
    const { handler } = build(inner);
    await handler.sendMessage({ message: message('m1') }).catch(() => {});
    expect(loggedActions().filter((a) => a === 'a2a.task_store.save_failed').length).toBeGreaterThanOrEqual(3);
    const [fields] = logged.error[0] as [{ taskId: string; err: { message: string; stack: string } }];
    expect(fields.taskId).toMatch(/[0-9a-f-]{36}/);
    expect(fields.err.message).toBe(
      "MISCONF Redis is configured to save RDB snapshots, but it's currently unable to persist to disk.",
    );
    expect(fields.err.stack).toContain('FlakyStore.save');
  });

  it('when only the last save failed, the task is stored as failed (one attempt) and read back failed', async () => {
    const inner = new FlakyStore();
    inner.failSaveAfter = 2;
    const { handler } = build(inner);
    let taskId = '';
    await handler.sendMessage({ message: message('m1') }).catch((e: A2AError) => { taskId = String(e.taskId ?? (e.data as { taskId: string }).taskId); });
    // markFailed's own write also fails here (the store keeps failing), so the
    // in-process record is what reports it.
    expect(loggedActions()).toContain('a2a.task_store.mark_failed_failed');
    inner.failSaveAfter = Infinity;
    const got = await handler.getTask({ id: taskId });
    expect(got.status.state).toBe('failed');
  });

  it('markFailed writes the failed status when the store has recovered', async () => {
    const inner = new FlakyStore();
    const store = new GuardedTaskStore(inner);
    const task: Task = { id: 't1', contextId: 'c1', kind: 'task', status: { state: 'working' } };
    await store.markFailed(task);
    expect(inner.tasks.get('t1')?.status.state).toBe('failed');
  });

  it('a failed read on the awaited path is a storage error, not "task not found"', async () => {
    const inner = new FlakyStore();
    const { handler } = build(inner);
    const sent = (await handler.sendMessage({ message: message('m1') })) as Task;
    inner.failLoad = true;
    await expect(handler.getTask({ id: sent.id })).rejects.toThrow(`Task storage failed (load of task ${sent.id})`);
    expect(loggedActions()).toContain('a2a.task_store.load_failed');
  });

  it('a follow-up on an existing task whose save fails is an error', async () => {
    const inner = new FlakyStore();
    const { handler } = build(inner);
    const sent = (await handler.sendMessage({ message: message('m1') })) as Task;
    // completed is terminal; give the SDK a non-terminal stored task to continue
    inner.tasks.set(sent.id, { ...inner.tasks.get(sent.id)!, status: { state: 'input-required' } });
    inner.failSaveAfter = inner.saves;
    await expect(handler.sendMessage({ message: message('m2', sent.id) })).rejects.toThrow('Task storage failed');
  });
});

describe('store fails during background processing: the process survives', () => {
  it('non-blocking send: first result stored and returned; later failed saves are logged, not thrown', async () => {
    const inner = new FlakyStore();
    inner.failSaveAfter = 1;
    const { handler } = build(inner);
    const first = (await handler.sendMessage({ message: message('m1'), configuration: { blocking: false } })) as Task;
    expect(first.status.state).toBe('submitted');
    await settle();
    expect(loggedActions()).toContain('a2a.task_store.save_failed');
    // The stored copy is stale ("submitted"); reading it reports the failure.
    inner.failSaveAfter = Infinity;
    const got = await handler.getTask({ id: first.id });
    expect(got.status.state).toBe('failed');
  });

  it('blocking send with every save failing: no unhandled rejection (the 0.3.10 crash path)', async () => {
    const inner = new FlakyStore();
    inner.failSaveAfter = 0;
    const { handler } = build(inner);
    await handler.sendMessage({ message: message('m1') }).catch(() => {});
    // afterEach asserts the unhandledRejection listener saw nothing
  });

  it('cancel whose first read fails: caller gets a storage error', async () => {
    const inner = new FlakyStore();
    inner.tasks.set('t-cancel', { id: 't-cancel', contextId: 'ctx', kind: 'task', status: { state: 'working' } });
    const { handler } = build(inner);
    inner.failLoad = true;
    await expect(handler.cancelTask({ id: 't-cancel' })).rejects.toThrow('Task storage failed (load of task t-cancel)');
  });

  it("cancel whose read INSIDE the SDK's event loop fails: storage error, no unhandled rejection", async () => {
    const inner = new FlakyStore();
    const { handler } = createGuardedRequestHandler(inner, (s) => new DefaultRequestHandler(card, s, new RunsUntilCancelled()));
    const started = (await handler.sendMessage({ message: message('m1'), configuration: { blocking: false } })) as Task;
    // cancelTask: one awaited load succeeds, then the loop's load (status
    // update with no current task) fails -- the path that rethrew unawaited.
    inner.failLoadAfter = inner.loads + 1;
    await expect(handler.cancelTask({ id: started.id })).rejects.toThrow(`Task storage failed (load of task ${started.id})`);
  });

  it('stream: a failed save ends the stream with a storage error', async () => {
    const inner = new FlakyStore();
    inner.failSaveAfter = 1;
    const { handler } = build(inner);
    const seen: string[] = [];
    const run = async () => { for await (const e of handler.sendMessageStream({ message: message('m1') })) seen.push(e.kind); };
    await expect(run()).rejects.toThrow('Task storage failed');
    expect(seen).toEqual(['task']);
  });
});

describe('bounded memory of failed tasks', () => {
  it(`forgets the oldest after ${MAX_REMEMBERED_FAILED_TASKS} ids`, async () => {
    const inner = new FlakyStore();
    inner.failSaveAfter = 0;
    const store = new GuardedTaskStore(inner);
    for (let i = 0; i <= MAX_REMEMBERED_FAILED_TASKS; i++) {
      await store.save({ id: `t${i}`, contextId: 'c', kind: 'task', status: { state: 'working' } });
    }
    expect(store.hasFailed('t0')).toBe(false);
    expect(store.hasFailed('t1')).toBe(true);
    expect(store.hasFailed(`t${MAX_REMEMBERED_FAILED_TASKS}`)).toBe(true);
  });
});

describe('wiring', () => {
  it('the server hands the SDK the guarded store and the transport the guarded handler', () => {
    const src = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(src).toContain('createGuardedRequestHandler(');
    expect(src).toMatch(/new DefaultRequestHandler\(agentCard, guardedStore, executor\)/);
    expect(src).not.toMatch(/new DefaultRequestHandler\(agentCard, taskStore,/);
  });
});
