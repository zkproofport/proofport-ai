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
 *
 * A2A v0.3 streaming format — each SSE data line contains a JSON-RPC response
 * where result is either:
 *   - TaskStatusUpdateEvent: { id, status, final }  — detected by 'status' field
 *   - TaskArtifactUpdateEvent: { id, artifact, final } — detected by 'artifact' field
 *
 * a2a-ui discriminates events via duck-typing ('status' in event vs 'artifact' in event)
 * and stops streaming when final === true.
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
    let result: unknown;

    if (event.type === 'statusUpdate') {
      const data = event.data as StatusUpdateEvent;
      result = {
        id: data.taskId,
        status: data.status,
        final: data.final,
      };
    } else if (event.type === 'artifactUpdate') {
      const data = event.data as ArtifactUpdateEvent;
      result = {
        id: data.taskId,
        artifact: {
          ...data.artifact,
          artifactId: data.artifact.id,
        },
        final: false,
      };
    } else if (event.type === 'task') {
      // Final task event — close the stream.
      // The preceding statusUpdate with final:true already carries completion data.
      const task = event.data as A2aTask;
      result = {
        id: task.id,
        status: task.status,
        final: true,
      };
    }

    const response = {
      jsonrpc: '2.0' as const,
      id: jsonRpcId,
      result,
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
