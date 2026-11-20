import { AsyncLocalStorage } from 'node:async_hooks';
import type { Task } from '@a2a-js/sdk';
import type {
  A2ARequestHandler,
  ServerCallContext,
  TaskStore,
} from '@a2a-js/sdk/server';
import { A2AError } from '@a2a-js/sdk/server';
import { createLogger } from '../logger.js';

const log = createLogger('A2ATaskStore');

/**
 * Why this file exists.
 *
 * `@a2a-js/sdk` 0.3.10's `DefaultRequestHandler._processEvents` catches an
 * error from the task store and hands it to `_handleProcessingError` WITHOUT
 * awaiting it. When the call has no `firstResultRejector` (a blocking
 * `message/send`, `tasks/cancel`) that async function rethrows, so the error
 * becomes an unhandled rejection and Node ends the process. One Redis write
 * failure (seen: `MISCONF`, disk full) took the whole server down. The same
 * loop also loads tasks (`tasks/cancel` publishes a status update before any
 * task), so a failing read reaches the same path.
 *
 * The fix sits at our side of that boundary, in two halves that only work
 * together:
 *
 *  - {@link GuardedTaskStore} never lets a store error escape into the SDK. It
 *    logs the failure in full, records it against the request being served,
 *    and remembers a task whose save failed so a later read reports it failed.
 *  - {@link GuardedRequestHandler} runs every request in its own failure
 *    record and turns any recorded failure into an error for the caller. A
 *    request whose task could not be stored is never answered as a success.
 *
 * The store alone would hide the outage (a blocking send would answer with a
 * task that was never stored); the handler alone cannot stop the unhandled
 * rejection. So the guarded store must only ever be handed to a guarded
 * handler; `createGuardedRequestHandler` builds the pair.
 */

export interface TaskStoreFailure {
  operation: 'save' | 'load';
  taskId: string;
  error: Error;
}

/** The failures recorded while one request was being served. */
const requestFailures = new AsyncLocalStorage<TaskStoreFailure[]>();

/** How many failed task ids are remembered for {@link GuardedTaskStore.load}. */
export const MAX_REMEMBERED_FAILED_TASKS = 10_000;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The status written over a task whose save failed. */
function failedStatus(task: Task, reason: string): Task['status'] {
  return {
    state: 'failed',
    message: {
      kind: 'message',
      role: 'agent',
      messageId: `store-failure-${task.id}`,
      parts: [{ kind: 'text', text: reason }],
      taskId: task.id,
      contextId: task.contextId,
    },
    timestamp: new Date().toISOString(),
  };
}

const SAVE_FAILED_REASON = 'The task could not be stored; its result is not available. Send the request again.';

export class GuardedTaskStore implements TaskStore {
  /** Ids of tasks whose save failed. Insertion-ordered, bounded. */
  private readonly failedTasks = new Set<string>();

  constructor(private readonly inner: TaskStore) {}

  async save(task: Task, context?: ServerCallContext): Promise<void> {
    try {
      await this.inner.save(task, context);
    } catch (raw) {
      const error = asError(raw);
      this.record({ operation: 'save', taskId: task.id, error });
      this.rememberFailed(task.id);
    }
  }

  async load(taskId: string, context?: ServerCallContext): Promise<Task | undefined> {
    let task: Task | undefined;
    try {
      task = await this.inner.load(taskId, context);
    } catch (raw) {
      // Inside the SDK's event loop a throw here is the same unhandled
      // rejection as a failed save. The request handler reports it instead.
      this.record({ operation: 'load', taskId, error: asError(raw) });
      return undefined;
    }
    if (!task || !this.failedTasks.has(taskId) || task.status?.state === 'failed') return task;
    // What the store holds is older than what happened: a later save failed.
    return { ...task, status: failedStatus(task, SAVE_FAILED_REASON) };
  }

  /** Whether a save of this task has failed in this process. */
  hasFailed(taskId: string): boolean {
    return this.failedTasks.has(taskId);
  }

  /**
   * One attempt to store `task` as failed, after a request on it could not
   * be stored. Never throws: when this write fails too, it is logged and the
   * in-process record is what reports the task failed.
   */
  async markFailed(task: Task): Promise<void> {
    try {
      await this.inner.save({ ...task, status: failedStatus(task, SAVE_FAILED_REASON) });
      log.warn({ action: 'a2a.task_store.marked_failed', taskId: task.id, contextId: task.contextId },
        'Stored the task as failed after an earlier write failed');
    } catch (raw) {
      const error = asError(raw);
      log.error({ action: 'a2a.task_store.mark_failed_failed', taskId: task.id, contextId: task.contextId,
        err: { message: error.message, name: error.name, stack: error.stack } },
        'Could not store the task as failed either');
    }
  }

  private record(failure: TaskStoreFailure): void {
    const { error } = failure;
    log.error({
      action: `a2a.task_store.${failure.operation}_failed`,
      taskId: failure.taskId,
      err: { message: error.message, name: error.name, stack: error.stack },
    }, `Task store ${failure.operation} failed`);
    requestFailures.getStore()?.push(failure);
  }

  private rememberFailed(taskId: string): void {
    this.failedTasks.delete(taskId);
    this.failedTasks.add(taskId);
    for (const oldest of this.failedTasks) {
      if (this.failedTasks.size <= MAX_REMEMBERED_FAILED_TASKS) break;
      this.failedTasks.delete(oldest);
    }
  }
}

/**
 * The error the caller sees. It names the operation and the task, not the
 * store's own message (that names the backing service): the full error is in
 * the log line `record` wrote.
 */
function storageError(failures: TaskStoreFailure[]): A2AError {
  const first = failures[0];
  return A2AError.internalError(
    `Task storage failed (${first.operation} of task ${first.taskId}); the request did not complete. Send it again.`,
    { taskId: first.taskId },
  );
}

function isTask(value: unknown): value is Task {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'task';
}

/**
 * Every method of the wrapped handler, run inside its own failure record.
 * A failure recorded while the call ran turns a success into an error, and
 * replaces the error the SDK derived from it (a failed load reads as "task
 * not found") with one that names the storage failure.
 */
export class GuardedRequestHandler implements A2ARequestHandler {
  constructor(
    private readonly inner: A2ARequestHandler,
    private readonly store: GuardedTaskStore,
  ) {}

  private async guarded<T>(call: () => Promise<T>): Promise<T> {
    const failures: TaskStoreFailure[] = [];
    let result: T;
    try {
      result = await requestFailures.run(failures, call);
    } catch (error) {
      if (failures.length > 0) throw storageError(failures);
      throw error;
    }
    if (failures.length > 0) {
      if (isTask(result)) await this.store.markFailed(result);
      throw storageError(failures);
    }
    return result;
  }

  /**
   * A generator's body runs in the context of whoever calls `next()`, not of
   * whoever created it, so each step is run inside this request's record.
   */
  private async *guardedStream<T>(open: () => AsyncGenerator<T, void, undefined>): AsyncGenerator<T, void, undefined> {
    const failures: TaskStoreFailure[] = [];
    const stream = open();
    let finished = false;
    try {
      while (true) {
        let step: IteratorResult<T, void>;
        try {
          step = await requestFailures.run(failures, () => stream.next());
        } catch (error) {
          finished = true;
          if (failures.length > 0) throw storageError(failures);
          throw error;
        }
        if (failures.length > 0) throw storageError(failures);
        if (step.done) {
          finished = true;
          return;
        }
        yield step.value;
      }
    } finally {
      if (!finished) await requestFailures.run(failures, () => stream.return(undefined));
    }
  }

  getAgentCard: A2ARequestHandler['getAgentCard'] = () => this.inner.getAgentCard();
  getAuthenticatedExtendedAgentCard: A2ARequestHandler['getAuthenticatedExtendedAgentCard'] = (context) =>
    this.inner.getAuthenticatedExtendedAgentCard(context);
  sendMessage: A2ARequestHandler['sendMessage'] = (params, context) =>
    this.guarded(() => this.inner.sendMessage(params, context));
  sendMessageStream: A2ARequestHandler['sendMessageStream'] = (params, context) =>
    this.guardedStream(() => this.inner.sendMessageStream(params, context));
  getTask: A2ARequestHandler['getTask'] = (params, context) =>
    this.guarded(() => this.inner.getTask(params, context));
  cancelTask: A2ARequestHandler['cancelTask'] = (params, context) =>
    this.guarded(() => this.inner.cancelTask(params, context));
  setTaskPushNotificationConfig: A2ARequestHandler['setTaskPushNotificationConfig'] = (params, context) =>
    this.guarded(() => this.inner.setTaskPushNotificationConfig(params, context));
  getTaskPushNotificationConfig: A2ARequestHandler['getTaskPushNotificationConfig'] = (params, context) =>
    this.guarded(() => this.inner.getTaskPushNotificationConfig(params, context));
  listTaskPushNotificationConfigs: A2ARequestHandler['listTaskPushNotificationConfigs'] = (params, context) =>
    this.guarded(() => this.inner.listTaskPushNotificationConfigs(params, context));
  deleteTaskPushNotificationConfig: A2ARequestHandler['deleteTaskPushNotificationConfig'] = (params, context) =>
    this.guarded(() => this.inner.deleteTaskPushNotificationConfig(params, context));
  resubscribe: A2ARequestHandler['resubscribe'] = (params, context) =>
    this.guardedStream(() => this.inner.resubscribe(params, context));
}

/**
 * The guarded store and the handler that reports its failures, built
 * together so one is never used without the other. `build` receives the
 * store to give the SDK's request handler.
 */
export function createGuardedRequestHandler(
  store: TaskStore,
  build: (guardedStore: GuardedTaskStore) => A2ARequestHandler,
): { handler: GuardedRequestHandler; store: GuardedTaskStore } {
  const guardedStore = new GuardedTaskStore(store);
  return { handler: new GuardedRequestHandler(build(guardedStore), guardedStore), store: guardedStore };
}
