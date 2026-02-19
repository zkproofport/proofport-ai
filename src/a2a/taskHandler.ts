import type { Request, Response, RequestHandler } from 'express';
import type { TaskStore, Message, DataPart, TextPart } from './taskStore.js';
import type { TaskEventEmitter } from './streaming.js';
import { attachSseStream } from './streaming.js';
import type { PaymentFacilitator } from '../payment/facilitator.js';
import type { LLMProvider } from '../chat/llmProvider.js';
import { CHAT_TOOLS } from '../chat/tools.js';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('a2a-handler');

export interface A2aHandlerDeps {
  taskStore: TaskStore;
  taskEventEmitter: TaskEventEmitter;
  paymentFacilitator?: PaymentFacilitator;
  llmProvider?: LLMProvider;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const VALID_SKILLS = ['generate_proof', 'verify_proof', 'get_supported_circuits'];

function jsonRpcError(id: string | number | undefined, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonRpcResult(id: string | number | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Extract skill and params from a DataPart with explicit skill field.
 * Returns null if no DataPart contains a skill.
 */
function extractSkillFromDataPart(message: Message): { skill: string; params: Record<string, unknown> } | null {
  for (const part of message.parts) {
    if (part.kind === 'data') {
      const dataPart = part as DataPart;
      const data = dataPart.data as Record<string, unknown>;
      if (data && typeof data.skill === 'string') {
        const { skill, ...params } = data;
        return { skill, params };
      }
    }
  }
  return null;
}

export const A2A_INFERENCE_PROMPT = `You are a skill router for proveragent.eth. Given user text, determine which tool to call and extract parameters. ALWAYS respond with a tool call — never with plain text.`;

/**
 * Use LLM tool-calling to infer skill and params from free-form text.
 * Enforces tool_choice: required and times out after 30 seconds.
 */
async function inferSkillFromText(text: string, llmProvider: LLMProvider): Promise<{ skill: string; params: Record<string, unknown> }> {
  const timeoutMs = 30000;
  const response = await Promise.race([
    llmProvider.chat(
      [{ role: 'user', content: text }],
      A2A_INFERENCE_PROMPT,
      CHAT_TOOLS,
      { toolChoice: 'required' }
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('LLM inference timed out after 30 seconds')), timeoutMs)
    ),
  ]);

  if (response.toolCalls && response.toolCalls.length > 0) {
    const toolCall = response.toolCalls[0];
    return { skill: toolCall.name, params: toolCall.args };
  }

  throw new Error('Could not determine skill from message. The LLM did not return a tool call.');
}

/**
 * Resolve skill and params from a message.
 * Tries DataPart first (instant), falls back to LLM inference for TextPart.
 * Throws with an error message if resolution fails.
 */
async function resolveSkill(
  message: Message,
  llmProvider?: LLMProvider,
): Promise<{ skill: string; params: Record<string, unknown> }> {
  // Try DataPart first (instant, no LLM needed)
  const dataPartResult = extractSkillFromDataPart(message);
  if (dataPartResult) {
    return dataPartResult;
  }

  // TextPart — use LLM inference
  const textContent = message.parts
    .filter((p): p is TextPart => p.kind === 'text')
    .map(p => p.text)
    .join(' ');

  if (!textContent.trim()) {
    throw new Error('Message contains no text or data parts');
  }

  if (!llmProvider) {
    throw new Error('Text inference requires LLM configuration. Use a DataPart with { "skill": "..." } for direct routing.');
  }

  return inferSkillFromText(textContent, llmProvider);
}

export function createA2aHandler(deps: A2aHandlerDeps): RequestHandler {
  const { taskStore, taskEventEmitter, paymentFacilitator, llmProvider } = deps;

  return async (req: Request, res: Response): Promise<void> => {
    const body = req.body as JsonRpcRequest;

    if (!body.jsonrpc || body.jsonrpc !== '2.0') {
      res.json(jsonRpcError(body.id, -32600, 'Invalid request: jsonrpc field must be "2.0"'));
      return;
    }

    if (!body.method) {
      res.json(jsonRpcError(body.id, -32600, 'Invalid request: method field is required'));
      return;
    }

    try {
      switch (body.method) {
        case 'message/send':
          await handleMessageSend(body, res, taskStore, taskEventEmitter, paymentFacilitator, req, llmProvider);
          break;

        case 'message/stream':
          await handleMessageStream(body, res, taskStore, taskEventEmitter, paymentFacilitator, req, llmProvider);
          break;

        case 'tasks/get':
          await handleTaskGet(body, res, taskStore);
          break;

        case 'tasks/cancel':
          await handleTaskCancel(body, res, taskStore);
          break;

        case 'tasks/resubscribe':
          await handleTaskResubscribe(body, res, taskStore, taskEventEmitter);
          break;

        default:
          res.json(jsonRpcError(body.id, -32601, `Method not found: ${body.method}`));
      }
    } catch (error) {
      res.json(jsonRpcError(body.id, -32603, error instanceof Error ? error.message : 'Internal error'));
    }
  };
}

async function handleMessageSend(
  body: JsonRpcRequest,
  res: Response,
  taskStore: TaskStore,
  taskEventEmitter: TaskEventEmitter,
  paymentFacilitator?: PaymentFacilitator,
  req?: Request,
  llmProvider?: LLMProvider
): Promise<void> {
  const span = tracer.startSpan('a2a.message.send');
  try {
    const params = body.params || {};
    const message = params.message as Message | undefined;

    if (!message || !message.role || !Array.isArray(message.parts) || message.parts.length === 0) {
      res.json(jsonRpcError(body.id, -32602, 'Invalid params: message with role and non-empty parts is required'));
      span.setStatus({ code: SpanStatusCode.OK });
      return;
    }

    // Extract skill from message
    let skill: string;
    let skillParams: Record<string, unknown>;
    try {
      const resolved = await resolveSkill(message, llmProvider);
      skill = resolved.skill;
      skillParams = resolved.params;
    } catch (error) {
      res.json(jsonRpcError(body.id, -32602, error instanceof Error ? error.message : 'Could not extract skill'));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : 'Could not extract skill' });
      return;
    }

    if (!VALID_SKILLS.includes(skill)) {
      res.json(jsonRpcError(body.id, -32602, `Invalid skill: ${skill}. Valid skills: ${VALID_SKILLS.join(', ')}`));
      span.setStatus({ code: SpanStatusCode.ERROR, message: `Invalid skill: ${skill}` });
      return;
    }

    const contextId = (params.message as any)?.contextId;
    if (contextId) span.setAttribute('session_id', contextId);
    span.setAttribute('a2a.skill', skill);

    // Add timestamp to user message
    const userMessage: Message = {
      ...message,
      timestamp: message.timestamp || new Date().toISOString(),
    };

    // Create task
    const task = await taskStore.createTask(skill, skillParams, userMessage);
    span.setAttribute('a2a.task_id', task.id);

    // Record payment if present
    if (paymentFacilitator && req) {
      const paymentInfo = (req as any).x402Payment;
      if (paymentInfo) {
        try {
          await paymentFacilitator.recordPayment({
            taskId: task.id,
            payerAddress: paymentInfo.payerAddress,
            amount: paymentInfo.amount,
            network: paymentInfo.network,
          });
        } catch (error) {
          console.error(`Failed to record payment for task ${task.id}:`, error);
        }
      }
    }

    // Wait for task completion (blocking)
    const completedTask = await waitForTaskCompletion(task.id, taskStore, taskEventEmitter, 120000);
    res.json(jsonRpcResult(body.id, completedTask));
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    span.end();
  }
}

async function handleMessageStream(
  body: JsonRpcRequest,
  res: Response,
  taskStore: TaskStore,
  taskEventEmitter: TaskEventEmitter,
  paymentFacilitator?: PaymentFacilitator,
  req?: Request,
  llmProvider?: LLMProvider
): Promise<void> {
  const span = tracer.startSpan('a2a.message.stream');
  try {
    const params = body.params || {};
    const message = params.message as Message | undefined;

    if (!message || !message.role || !Array.isArray(message.parts) || message.parts.length === 0) {
      res.json(jsonRpcError(body.id, -32602, 'Invalid params: message with role and non-empty parts is required'));
      span.setStatus({ code: SpanStatusCode.OK });
      return;
    }

    let skill: string;
    let skillParams: Record<string, unknown>;
    try {
      const resolved = await resolveSkill(message, llmProvider);
      skill = resolved.skill;
      skillParams = resolved.params;
    } catch (error) {
      res.json(jsonRpcError(body.id, -32602, error instanceof Error ? error.message : 'Could not extract skill'));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : 'Could not extract skill' });
      return;
    }

    if (!VALID_SKILLS.includes(skill)) {
      res.json(jsonRpcError(body.id, -32602, `Invalid skill: ${skill}. Valid skills: ${VALID_SKILLS.join(', ')}`));
      span.setStatus({ code: SpanStatusCode.ERROR, message: `Invalid skill: ${skill}` });
      return;
    }

    const contextId = (params.message as any)?.contextId;
    if (contextId) span.setAttribute('session_id', contextId);
    span.setAttribute('a2a.skill', skill);

    const userMessage: Message = {
      ...message,
      timestamp: message.timestamp || new Date().toISOString(),
    };

    const task = await taskStore.createTask(skill, skillParams, userMessage);
    span.setAttribute('a2a.task_id', task.id);

    // Record payment if present
    if (paymentFacilitator && req) {
      const paymentInfo = (req as any).x402Payment;
      if (paymentInfo) {
        try {
          await paymentFacilitator.recordPayment({
            taskId: task.id,
            payerAddress: paymentInfo.payerAddress,
            amount: paymentInfo.amount,
            network: paymentInfo.network,
          });
        } catch (error) {
          console.error(`Failed to record payment for task ${task.id}:`, error);
        }
      }
    }

    // Attach SSE stream
    attachSseStream(res, taskEventEmitter, task.id, body.id || '');
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    span.end();
  }
}

async function handleTaskGet(
  body: JsonRpcRequest,
  res: Response,
  taskStore: TaskStore
): Promise<void> {
  const span = tracer.startSpan('a2a.tasks.get');
  try {
    const params = body.params || {};

    if (!params.id || typeof params.id !== 'string') {
      res.json(jsonRpcError(body.id, -32602, 'Invalid params: id is required'));
      span.setStatus({ code: SpanStatusCode.OK });
      return;
    }

    span.setAttribute('a2a.task_id', params.id as string);

    const task = await taskStore.getTask(params.id);

    if (!task) {
      res.json(jsonRpcError(body.id, -32001, 'Task not found'));
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Task not found' });
      return;
    }

    // Support historyLength parameter
    const historyLength = typeof params.historyLength === 'number' ? params.historyLength : undefined;
    if (historyLength !== undefined && task.history) {
      task.history = task.history.slice(-historyLength);
    }

    res.json(jsonRpcResult(body.id, task));
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    span.end();
  }
}

async function handleTaskCancel(
  body: JsonRpcRequest,
  res: Response,
  taskStore: TaskStore
): Promise<void> {
  const span = tracer.startSpan('a2a.tasks.cancel');
  try {
    const params = body.params || {};

    if (!params.id || typeof params.id !== 'string') {
      res.json(jsonRpcError(body.id, -32602, 'Invalid params: id is required'));
      span.setStatus({ code: SpanStatusCode.OK });
      return;
    }

    span.setAttribute('a2a.task_id', params.id as string);

    try {
      const updatedTask = await taskStore.updateTaskStatus(params.id, 'canceled');
      res.json(jsonRpcResult(body.id, updatedTask));
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Invalid status transition')) {
        res.json(jsonRpcError(body.id, -32002, error.message));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        return;
      }
      if (error instanceof Error && error.message === 'Task not found') {
        res.json(jsonRpcError(body.id, -32001, 'Task not found'));
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Task not found' });
        return;
      }
      throw error;
    }
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
    throw err;
  } finally {
    span.end();
  }
}

async function handleTaskResubscribe(
  body: JsonRpcRequest,
  res: Response,
  taskStore: TaskStore,
  taskEventEmitter: TaskEventEmitter
): Promise<void> {
  const params = body.params || {};

  if (!params.id || typeof params.id !== 'string') {
    res.json(jsonRpcError(body.id, -32602, 'Invalid params: id is required'));
    return;
  }

  const task = await taskStore.getTask(params.id);
  if (!task) {
    res.json(jsonRpcError(body.id, -32001, 'Task not found'));
    return;
  }

  // If task is already in terminal state, return it directly
  const terminalStates = ['completed', 'failed', 'canceled', 'rejected'];
  if (terminalStates.includes(task.status.state)) {
    res.json(jsonRpcResult(body.id, task));
    return;
  }

  // Attach SSE stream for ongoing task
  attachSseStream(res, taskEventEmitter, task.id, body.id || '');
}

/**
 * Wait for a task to reach a terminal state.
 * Used by message/send (blocking mode).
 */
function waitForTaskCompletion(
  taskId: string,
  taskStore: TaskStore,
  emitter: TaskEventEmitter,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      emitter.removeListener(`task:${taskId}`, listener);
      // Return current task state on timeout
      const task = await taskStore.getTask(taskId);
      if (task) {
        resolve(task);
      } else {
        reject(new Error('Task not found after timeout'));
      }
    }, timeoutMs);

    const listener = (event: { type: string; data: unknown }) => {
      if (event.type === 'task') {
        clearTimeout(timeout);
        emitter.removeListener(`task:${taskId}`, listener);
        resolve(event.data);
      }
    };

    emitter.on(`task:${taskId}`, listener);
  });
}
