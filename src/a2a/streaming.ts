import { EventEmitter } from 'events';
import type { Response } from 'express';
import type { A2aTask, TaskStatus, Artifact } from './taskStore.js';

// A2A v0.3 streaming event types
export interface StatusUpdateEvent {
  taskId: string;
  status: TaskStatus;
  final: boolean;
}

export interface ArtifactUpdateEvent {
  taskId: string;
  artifact: Artifact;
}

export type StreamingResult =
  | { task: A2aTask }
  | { statusUpdate: StatusUpdateEvent }
  | { artifactUpdate: ArtifactUpdateEvent };

export class TaskEventEmitter extends EventEmitter {
  emitStatusUpdate(taskId: string, status: TaskStatus, final: boolean): void {
    const event: StatusUpdateEvent = { taskId, status, final };
    this.emit(`task:${taskId}`, { type: 'statusUpdate', data: event });
  }

  emitArtifactUpdate(taskId: string, artifact: Artifact): void {
    const event: ArtifactUpdateEvent = { taskId, artifact };
    this.emit(`task:${taskId}`, { type: 'artifactUpdate', data: event });
  }

  emitTaskComplete(taskId: string, task: A2aTask): void {
    this.emit(`task:${taskId}`, { type: 'task', data: task });
  }

  removeTaskListeners(taskId: string): void {
    this.removeAllListeners(`task:${taskId}`);
  }
}

/**
 * Write an SSE stream for a task. Used by both message/stream and tasks/resubscribe.
 */
export function attachSseStream(
  res: Response,
  emitter: TaskEventEmitter,
  taskId: string,
  jsonRpcId: string | number
): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(':keepalive\n\n');

  const eventListener = (event: { type: string; data: unknown }) => {
    const response = {
      jsonrpc: '2.0' as const,
      id: jsonRpcId,
      result: { [event.type]: event.data },
    };
    res.write(`data: ${JSON.stringify(response)}\n\n`);

    // Close stream on final task event
    if (event.type === 'task') {
      res.end();
    }
  };

  emitter.on(`task:${taskId}`, eventListener);

  res.on('close', () => {
    emitter.removeListener(`task:${taskId}`, eventListener);
  });
}
