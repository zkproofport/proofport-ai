import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock OpenTelemetry tracing — must happen before any import of taskHandler
vi.mock('@opentelemetry/api', () => {
  const noop = () => ({});
  const span = {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
  return {
    trace: {
      getTracer: () => ({ startSpan: () => span }),
    },
    SpanStatusCode: { OK: 'OK', ERROR: 'ERROR' },
  };
});

// Mock streaming — attachSseStream is not under test here
vi.mock('../src/a2a/streaming.js', () => ({
  attachSseStream: vi.fn(),
  TaskEventEmitter: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    removeListener: vi.fn(),
    emit: vi.fn(),
  })),
}));

import { createA2aHandler, A2A_INFERENCE_PROMPT } from '../src/a2a/taskHandler.js';
import type { A2aHandlerDeps } from '../src/a2a/taskHandler.js';

// All 6 canonical skill names — validated via the error message when an unknown skill is submitted
const EXPECTED_SKILLS = ['request_signing', 'check_status', 'request_payment', 'generate_proof', 'verify_proof', 'get_supported_circuits'];
import type { A2aTask } from '../src/a2a/taskStore.js';
import { TaskEventEmitter } from '../src/a2a/streaming.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<A2aTask> = {}): A2aTask {
  return {
    id: 'task-abc',
    contextId: 'ctx-1',
    skill: 'generate_proof',
    params: {},
    status: { state: 'completed', timestamp: new Date().toISOString() },
    history: [],
    artifacts: [],
    metadata: {},
    kind: 'task',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<A2aHandlerDeps> = {}): A2aHandlerDeps {
  return {
    taskStore: {
      createTask: vi.fn(),
      getTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      addArtifact: vi.fn(),
    } as any,
    taskEventEmitter: new (vi.mocked(TaskEventEmitter))() as any,
    ...overrides,
  };
}

function makeApp(deps?: Partial<A2aHandlerDeps>) {
  const app = express();
  app.use(express.json());
  app.post('/rpc', createA2aHandler(makeDeps(deps)));
  return app;
}

/** Build a valid message/send body with a DataPart skill. */
function dataSendBody(skill: string, params: Record<string, unknown> = {}, id: number = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        parts: [{ kind: 'data', mimeType: 'application/json', data: { skill, ...params } }],
      },
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('A2A taskHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── VALID_SKILLS registry ─────────────────────────────────────────────────

  describe('VALID_SKILLS', () => {
    it('includes all 6 canonical skills (verified via rejection error)', async () => {
      // Submit each skill — none should return the "Invalid skill" error
      for (const skill of EXPECTED_SKILLS) {
        const deps = makeDeps();
        const completedTask = makeTask({ skill });
        vi.mocked(deps.taskStore.createTask).mockResolvedValue(completedTask);
        vi.mocked(deps.taskEventEmitter.on).mockImplementation((event: string, cb: any) => {
          setImmediate(() => cb({ type: 'task', data: completedTask }));
          return deps.taskEventEmitter;
        });

        const res = await request(makeApp(deps))
          .post('/rpc')
          .send(dataSendBody(skill));

        expect(res.body.error?.message, `skill "${skill}" should be valid`).toBeUndefined();
        vi.clearAllMocks();
      }
    });

    it('rejects skills that are not in the valid set', async () => {
      const res = await request(makeApp())
        .post('/rpc')
        .send(dataSendBody('not_a_real_skill'));

      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('Invalid skill: not_a_real_skill');
      // Error message must list all 6 valid skills
      for (const skill of EXPECTED_SKILLS) {
        expect(res.body.error.message).toContain(skill);
      }
    });
  });

  // ─── JSON-RPC validation ───────────────────────────────────────────────────

  describe('JSON-RPC protocol validation', () => {
    it('returns error -32600 when jsonrpc field is missing', async () => {
      const res = await request(makeApp())
        .post('/rpc')
        .send({ id: 1, method: 'message/send', params: {} });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(-32600);
      expect(res.body.error.message).toContain('jsonrpc field must be "2.0"');
    });

    it('returns error -32600 when jsonrpc is not "2.0"', async () => {
      const res = await request(makeApp())
        .post('/rpc')
        .send({ jsonrpc: '1.0', id: 1, method: 'message/send', params: {} });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32600);
    });

    it('returns error -32600 when method field is missing', async () => {
      const res = await request(makeApp())
        .post('/rpc')
        .send({ jsonrpc: '2.0', id: 1 });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32600);
      expect(res.body.error.message).toContain('method field is required');
    });

    it('returns error -32601 for unknown method', async () => {
      const res = await request(makeApp())
        .post('/rpc')
        .send({ jsonrpc: '2.0', id: 1, method: 'tasks/unknown' });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32601);
      expect(res.body.error.message).toContain('Method not found');
    });

    it('preserves the request id in all responses', async () => {
      const res = await request(makeApp())
        .post('/rpc')
        .send({ jsonrpc: '2.0', id: 42, method: 'tasks/unknown' });

      expect(res.body.id).toBe(42);
    });
  });

  // ─── message/send — DataPart routing ──────────────────────────────────────

  describe('message/send with DataPart skill', () => {
    it('creates task and waits for completion for generate_proof skill', async () => {
      const completedTask = makeTask({ id: 'task-gen', skill: 'generate_proof' });
      const deps = makeDeps();

      vi.mocked(deps.taskStore.createTask).mockResolvedValue(completedTask);

      // Simulate immediate task completion via event emitter
      vi.mocked(deps.taskEventEmitter.on).mockImplementation((event: string, cb: any) => {
        // fire the completion event synchronously so the test doesn't timeout
        setImmediate(() => cb({ type: 'task', data: completedTask }));
        return deps.taskEventEmitter;
      });

      const res = await request(makeApp(deps))
        .post('/rpc')
        .send(dataSendBody('generate_proof', { requestId: 'req-123' }));

      expect(res.status).toBe(200);
      expect(res.body.result).toMatchObject({ id: 'task-gen', skill: 'generate_proof' });
      expect(deps.taskStore.createTask).toHaveBeenCalledOnce();
      expect(deps.taskStore.createTask).toHaveBeenCalledWith(
        'generate_proof',
        { requestId: 'req-123' },
        expect.objectContaining({ role: 'user' }),
        undefined,
      );
    });

    it('routes request_signing DataPart to task creation', async () => {
      const completedTask = makeTask({ id: 'task-sign', skill: 'request_signing' });
      const deps = makeDeps();

      vi.mocked(deps.taskStore.createTask).mockResolvedValue(completedTask);
      vi.mocked(deps.taskEventEmitter.on).mockImplementation((event: string, cb: any) => {
        setImmediate(() => cb({ type: 'task', data: completedTask }));
        return deps.taskEventEmitter;
      });

      const res = await request(makeApp(deps))
        .post('/rpc')
        .send(dataSendBody('request_signing', { circuitId: 'coinbase_attestation', scope: 'myapp.com' }));

      expect(res.status).toBe(200);
      expect(deps.taskStore.createTask).toHaveBeenCalledWith(
        'request_signing',
        expect.objectContaining({ circuitId: 'coinbase_attestation', scope: 'myapp.com' }),
        expect.any(Object),
        undefined,
      );
    });

    it('records payment via paymentFacilitator when x402Payment is present', async () => {
      const completedTask = makeTask({ id: 'task-paid' });
      const mockRecordPayment = vi.fn().mockResolvedValue(undefined);

      const deps = makeDeps({
        paymentFacilitator: { recordPayment: mockRecordPayment } as any,
      });

      vi.mocked(deps.taskStore.createTask).mockResolvedValue(completedTask);
      vi.mocked(deps.taskEventEmitter.on).mockImplementation((event: string, cb: any) => {
        setImmediate(() => cb({ type: 'task', data: completedTask }));
        return deps.taskEventEmitter;
      });

      // Inject x402Payment middleware
      const app = express();
      app.use(express.json());
      app.use((req: any, _res, next) => {
        req.x402Payment = { payerAddress: '0xPayer', amount: '100000', network: 'base-sepolia' };
        next();
      });
      app.post('/rpc', createA2aHandler(deps));

      const res = await request(app)
        .post('/rpc')
        .send(dataSendBody('generate_proof', { requestId: 'req-paid' }));

      expect(res.status).toBe(200);
      expect(mockRecordPayment).toHaveBeenCalledOnce();
      expect(mockRecordPayment).toHaveBeenCalledWith({
        taskId: 'task-paid',
        payerAddress: '0xPayer',
        amount: '100000',
        network: 'base-sepolia',
      });
    });

    it('returns error -32602 for invalid skill name in DataPart', async () => {
      const res = await request(makeApp())
        .post('/rpc')
        .send(dataSendBody('do_something_illegal'));

      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('Invalid skill: do_something_illegal');
      expect(res.body.error.message).toContain('Valid skills:');
    });

    it('returns error -32602 when message is missing', async () => {
      const res = await request(makeApp())
        .post('/rpc')
        .send({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('message with role and non-empty parts is required');
    });

    it('returns error -32602 when message parts are empty', async () => {
      const res = await request(makeApp())
        .post('/rpc')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: { message: { role: 'user', parts: [] } },
        });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32602);
    });
  });

  // ─── message/send — TextPart → LLM inference ──────────────────────────────

  describe('message/send with TextPart (LLM inference)', () => {
    it('uses LLM inference to resolve skill from free-form text', async () => {
      const completedTask = makeTask({ id: 'task-llm', skill: 'get_supported_circuits' });
      const mockLlm = {
        name: 'mock-llm',
        chat: vi.fn().mockResolvedValue({
          toolCalls: [{ name: 'get_supported_circuits', args: {} }],
        }),
      };

      const deps = makeDeps({ llmProvider: mockLlm as any });
      vi.mocked(deps.taskStore.createTask).mockResolvedValue(completedTask);
      vi.mocked(deps.taskEventEmitter.on).mockImplementation((event: string, cb: any) => {
        setImmediate(() => cb({ type: 'task', data: completedTask }));
        return deps.taskEventEmitter;
      });

      const res = await request(makeApp(deps))
        .post('/rpc')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ kind: 'text', text: 'What circuits do you support?' }],
            },
          },
        });

      expect(res.status).toBe(200);
      expect(mockLlm.chat).toHaveBeenCalledOnce();
      // Should be called with the inference system prompt
      expect(mockLlm.chat).toHaveBeenCalledWith(
        [{ role: 'user', content: 'What circuits do you support?' }],
        A2A_INFERENCE_PROMPT,
        expect.any(Array),
        { toolChoice: 'required' },
      );
      expect(deps.taskStore.createTask).toHaveBeenCalledWith(
        'get_supported_circuits',
        {},
        expect.any(Object),
        undefined,
      );
    });

    it('returns error -32602 when no LLM provider is configured and TextPart is given', async () => {
      const deps = makeDeps({ llmProvider: undefined });

      const res = await request(makeApp(deps))
        .post('/rpc')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ kind: 'text', text: 'Generate a proof for me' }],
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('Text inference requires LLM configuration');
    });

    it('returns error -32602 when LLM returns no tool calls', async () => {
      const mockLlm = {
        name: 'mock-llm',
        chat: vi.fn().mockResolvedValue({ content: 'I am not sure what to do.' }),
      };

      const deps = makeDeps({ llmProvider: mockLlm as any });

      const res = await request(makeApp(deps))
        .post('/rpc')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ kind: 'text', text: 'do something weird' }],
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('Could not determine skill from message');
    });
  });

  // ─── tasks/get ─────────────────────────────────────────────────────────────

  describe('tasks/get', () => {
    it('returns task for valid id', async () => {
      const task = makeTask({ id: 'task-get-1' });
      const deps = makeDeps();
      vi.mocked(deps.taskStore.getTask).mockResolvedValue(task);

      const res = await request(makeApp(deps))
        .post('/rpc')
        .send({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'task-get-1' } });

      expect(res.status).toBe(200);
      expect(res.body.result).toMatchObject({ id: 'task-get-1' });
      expect(deps.taskStore.getTask).toHaveBeenCalledWith('task-get-1');
    });

    it('returns error -32001 when task is not found', async () => {
      const deps = makeDeps();
      vi.mocked(deps.taskStore.getTask).mockResolvedValue(null);

      const res = await request(makeApp(deps))
        .post('/rpc')
        .send({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'no-such-task' } });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(-32001);
      expect(res.body.error.message).toContain('Task not found');
    });

    it('returns error -32602 when id param is missing', async () => {
      const res = await request(makeApp())
        .post('/rpc')
        .send({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('id is required');
    });

    it('trims history to historyLength when provided', async () => {
      const task = makeTask({
        id: 'task-hist',
        history: [
          { role: 'user', parts: [{ kind: 'text', text: 'msg1' }] },
          { role: 'agent', parts: [{ kind: 'text', text: 'msg2' }] },
          { role: 'user', parts: [{ kind: 'text', text: 'msg3' }] },
        ],
      });
      const deps = makeDeps();
      vi.mocked(deps.taskStore.getTask).mockResolvedValue(task);

      const res = await request(makeApp(deps))
        .post('/rpc')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/get',
          params: { id: 'task-hist', historyLength: 1 },
        });

      expect(res.status).toBe(200);
      expect(res.body.result.history).toHaveLength(1);
      expect(res.body.result.history[0].parts[0].text).toBe('msg3');
    });
  });

  // ─── tasks/cancel ──────────────────────────────────────────────────────────

  describe('tasks/cancel', () => {
    it('cancels a queued task and returns updated task', async () => {
      const updatedTask = makeTask({ id: 'task-cancel', status: { state: 'canceled' } });
      const deps = makeDeps();
      vi.mocked(deps.taskStore.updateTaskStatus).mockResolvedValue(updatedTask);

      const res = await request(makeApp(deps))
        .post('/rpc')
        .send({ jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { id: 'task-cancel' } });

      expect(res.status).toBe(200);
      expect(res.body.result).toMatchObject({ id: 'task-cancel' });
      expect(deps.taskStore.updateTaskStatus).toHaveBeenCalledWith('task-cancel', 'canceled');
    });

    it('returns error -32001 when cancelling a non-existent task', async () => {
      const deps = makeDeps();
      vi.mocked(deps.taskStore.updateTaskStatus).mockRejectedValue(new Error('Task not found'));

      const res = await request(makeApp(deps))
        .post('/rpc')
        .send({ jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { id: 'ghost-task' } });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32001);
      expect(res.body.error.message).toBe('Task not found');
    });

    it('returns error -32002 for invalid state transition', async () => {
      const deps = makeDeps();
      vi.mocked(deps.taskStore.updateTaskStatus).mockRejectedValue(
        new Error('Invalid status transition from completed to canceled'),
      );

      const res = await request(makeApp(deps))
        .post('/rpc')
        .send({ jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { id: 'done-task' } });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32002);
      expect(res.body.error.message).toContain('Invalid status transition');
    });

    it('returns error -32602 when id param is missing', async () => {
      const res = await request(makeApp())
        .post('/rpc')
        .send({ jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: {} });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32602);
      expect(res.body.error.message).toContain('id is required');
    });
  });
});
