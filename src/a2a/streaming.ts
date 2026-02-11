import { EventEmitter } from 'events';
import type { Request, Response, RequestHandler } from 'express';

interface TaskEvent {
  type: string;
  taskId: string;
  timestamp: string;
  [key: string]: unknown;
}

interface TaskStatusEvent extends TaskEvent {
  type: 'task.status';
  status: string;
}

interface TaskProgressEvent extends TaskEvent {
  type: 'task.progress';
  step: string;
  detail?: string;
}

interface TaskArtifactEvent extends TaskEvent {
  type: 'task.artifact';
  artifact: Record<string, unknown>;
}

export class TaskEventEmitter extends EventEmitter {
  /**
   * Emit a task status change event
   */
  emitTaskStatus(taskId: string, status: string): void {
    const event: TaskStatusEvent = {
      type: 'task.status',
      taskId,
      status,
      timestamp: new Date().toISOString(),
    };
    this.emit(`task:${taskId}`, event);
  }

  /**
   * Emit a task progress update event
   */
  emitTaskProgress(taskId: string, step: string, detail?: string): void {
    const event: TaskProgressEvent = {
      type: 'task.progress',
      taskId,
      step,
      detail,
      timestamp: new Date().toISOString(),
    };
    this.emit(`task:${taskId}`, event);
  }

  /**
   * Emit a task artifact (proof result) event
   */
  emitTaskArtifact(taskId: string, artifact: Record<string, unknown>): void {
    const event: TaskArtifactEvent = {
      type: 'task.artifact',
      taskId,
      artifact,
      timestamp: new Date().toISOString(),
    };
    this.emit(`task:${taskId}`, event);
  }

  /**
   * Remove all listeners for a specific task
   */
  removeTaskListeners(taskId: string): void {
    this.removeAllListeners(`task:${taskId}`);
  }
}

/**
 * Create an Express handler for SSE streaming of task events
 */
export function createStreamHandler(emitter: TaskEventEmitter): RequestHandler {
  return (req: Request, res: Response, next) => {
    const { taskId } = req.params;

    if (!taskId) {
      res.status(404).json({ error: 'Task ID is required' });
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial keepalive comment
    res.write(':keepalive\n\n');

    // Create event listener for this task
    const eventListener = (event: TaskEvent) => {
      // Format as SSE: event: <type>\ndata: <json>\n\n
      const sseData = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      res.write(sseData);
    };

    // Register listener for this specific task
    emitter.on(`task:${taskId}`, eventListener);

    // Clean up on client disconnect
    res.on('close', () => {
      emitter.removeListener(`task:${taskId}`, eventListener);
    });
  };
}
