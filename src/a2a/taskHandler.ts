import type { Request, Response, RequestHandler } from 'express';
import type { TaskStore } from './taskStore.js';
import type { PaymentFacilitator } from '../payment/facilitator.js';

export interface A2aHandlerDeps {
  taskStore: TaskStore;
  paymentFacilitator?: PaymentFacilitator;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

const VALID_SKILLS = ['generate_proof', 'verify_proof', 'get_supported_circuits'];

export function createA2aHandler(deps: A2aHandlerDeps): RequestHandler {
  const { taskStore, paymentFacilitator } = deps;

  return async (req: Request, res: Response): Promise<void> => {
    const body = req.body as JsonRpcRequest;

    // Validate JSON-RPC format
    if (!body.jsonrpc || body.jsonrpc !== '2.0') {
      res.json({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32600,
          message: 'Invalid request: jsonrpc field must be "2.0"',
        },
      } satisfies JsonRpcResponse);
      return;
    }

    if (!body.method) {
      res.json({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32600,
          message: 'Invalid request: method field is required',
        },
      } satisfies JsonRpcResponse);
      return;
    }

    try {
      switch (body.method) {
        case 'tasks/send':
          await handleTaskSend(body, res, taskStore, paymentFacilitator, req);
          break;

        case 'tasks/get':
          await handleTaskGet(body, res, taskStore);
          break;

        case 'tasks/cancel':
          await handleTaskCancel(body, res, taskStore);
          break;

        default:
          res.json({
            jsonrpc: '2.0',
            id: body.id,
            error: {
              code: -32601,
              message: 'Method not found',
            },
          } satisfies JsonRpcResponse);
      }
    } catch (error) {
      res.json({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      } satisfies JsonRpcResponse);
    }
  };
}

async function handleTaskSend(
  body: JsonRpcRequest,
  res: Response,
  taskStore: TaskStore,
  paymentFacilitator?: PaymentFacilitator,
  req?: Request
): Promise<void> {
  const params = body.params || {};

  // Validate skill field
  if (!params.skill || typeof params.skill !== 'string') {
    res.json({
      jsonrpc: '2.0',
      id: body.id,
      error: {
        code: -32602,
        message: 'Invalid params: skill is required',
      },
    } satisfies JsonRpcResponse);
    return;
  }

  // Validate skill value
  if (!VALID_SKILLS.includes(params.skill)) {
    res.json({
      jsonrpc: '2.0',
      id: body.id,
      error: {
        code: -32602,
        message: `Invalid skill: ${params.skill}. Valid skills: ${VALID_SKILLS.join(', ')}`,
      },
    } satisfies JsonRpcResponse);
    return;
  }

  // Create task
  const task = await taskStore.createTask(params.skill, params);

  // Record payment if present (from recording middleware)
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
        // Log but don't fail request — payment was already validated by x402
        console.error(`Failed to record payment for task ${task.id}:`, error);
      }
    }
  }

  res.json({
    jsonrpc: '2.0',
    id: body.id,
    result: {
      id: task.id,
      status: task.status,
    },
  } satisfies JsonRpcResponse);
}

async function handleTaskGet(
  body: JsonRpcRequest,
  res: Response,
  taskStore: TaskStore
): Promise<void> {
  const params = body.params || {};

  if (!params.id || typeof params.id !== 'string') {
    res.json({
      jsonrpc: '2.0',
      id: body.id,
      error: {
        code: -32602,
        message: 'Invalid params: id is required',
      },
    } satisfies JsonRpcResponse);
    return;
  }

  const task = await taskStore.getTask(params.id);

  if (!task) {
    res.json({
      jsonrpc: '2.0',
      id: body.id,
      error: {
        code: -32001,
        message: 'Task not found',
      },
    } satisfies JsonRpcResponse);
    return;
  }

  res.json({
    jsonrpc: '2.0',
    id: body.id,
    result: task,
  } satisfies JsonRpcResponse);
}

async function handleTaskCancel(
  body: JsonRpcRequest,
  res: Response,
  taskStore: TaskStore
): Promise<void> {
  const params = body.params || {};

  if (!params.id || typeof params.id !== 'string') {
    res.json({
      jsonrpc: '2.0',
      id: body.id,
      error: {
        code: -32602,
        message: 'Invalid params: id is required',
      },
    } satisfies JsonRpcResponse);
    return;
  }

  try {
    const updatedTask = await taskStore.updateTaskStatus(params.id, 'canceled');

    res.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        id: updatedTask.id,
        status: updatedTask.status,
      },
    } satisfies JsonRpcResponse);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid status transition')) {
      res.json({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32002,
          message: error.message,
        },
      } satisfies JsonRpcResponse);
      return;
    }

    if (error instanceof Error && error.message === 'Task not found') {
      res.json({
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32001,
          message: 'Task not found',
        },
      } satisfies JsonRpcResponse);
      return;
    }

    throw error;
  }
}
