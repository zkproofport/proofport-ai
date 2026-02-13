import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { getAgentCardHandler } from '../../src/a2a/agentCard.js';
import { createA2aHandler } from '../../src/a2a/taskHandler.js';
import { TaskStore } from '../../src/a2a/taskStore.js';
import { TaskEventEmitter, createStreamHandler } from '../../src/a2a/streaming.js';
import type { Config } from '../../src/config/index.js';

describe('A2A Integration Tests', () => {
  let app: Express;
  let mockConfig: Config;
  let mockRedis: any;
  let taskStore: TaskStore;
  let taskEventEmitter: TaskEventEmitter;

  beforeEach(() => {
    // Create Express app
    app = express();
    app.use(express.json());

    // Mock config
    mockConfig = {
      nodeEnv: 'test',
      port: 3100,
      circuitsDir: '/tmp/circuits',
      circuitsRepoUrl: 'https://github.com/example/circuits',
      redisUrl: 'redis://localhost:6379',
      paymentMode: 'none',
      a2aBaseUrl: 'https://test.example.com',
      agentVersion: '1.0.0',
    } as Config;

    // Mock Redis client
    const taskData = new Map<string, string>();
    mockRedis = {
      set: vi.fn(async (key: string, value: string) => {
        taskData.set(key, value);
        return 'OK';
      }),
      get: vi.fn(async (key: string) => {
        return taskData.get(key) || null;
      }),
      lpush: vi.fn(async () => 1),
      quit: vi.fn(async () => {}),
    };

    // Create real instances with mocked Redis
    taskStore = new TaskStore(mockRedis, 86400);
    taskEventEmitter = new TaskEventEmitter();

    // Mount A2A routes
    app.get('/.well-known/agent.json', getAgentCardHandler(mockConfig));
    app.post('/a2a', createA2aHandler({ taskStore }));
    app.get('/a2a/stream/:taskId', createStreamHandler(taskEventEmitter));

    // Add MCP route for coexistence test
    app.post('/mcp', (_req, res) => {
      res.json({ jsonrpc: '2.0', result: { service: 'mcp' } });
    });
  });

  describe('GET /.well-known/agent.json', () => {
    it('returns valid Agent Card with Content-Type application/json', async () => {
      const response = await request(app).get('/.well-known/agent.json');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toMatchObject({
        name: 'ZKProofport Prover Agent',
        description: expect.any(String),
        url: 'https://test.example.com',
        version: '1.0.0',
        capabilities: {
          streaming: true,
          pushNotifications: false,
        },
        skills: expect.arrayContaining([
          expect.objectContaining({
            id: 'generate_proof',
            name: 'Generate ZK Proof',
          }),
        ]),
        authentication: {
          schemes: expect.arrayContaining([expect.objectContaining({ scheme: 'x402' })]),
        },
        identity: {
          erc8004: {
            contractAddress: expect.any(String),
            chainId: expect.any(Number),
            tokenId: null,
          },
        },
      });
    });
  });

  describe('POST /a2a', () => {
    it('returns task result for valid tasks/send request', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/send',
          params: {
            skill: 'generate_proof',
            circuitId: 'coinbase_attestation',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          id: expect.any(String),
          status: 'submitted',
        },
      });
    });

    it('returns JSON-RPC error for invalid method', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'invalid_method',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      });
    });

    it('returns error for missing skill in tasks/send', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/send',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32602,
          message: 'Invalid params: skill is required',
        },
      });
    });

    it('returns error for invalid skill value', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/send',
          params: {
            skill: 'invalid_skill',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32602,
          message: expect.stringContaining('Invalid skill'),
        },
      });
    });
  });

  describe('GET /a2a/stream/:taskId', () => {
    it('sets SSE headers for valid taskId', (done) => {
      const req = request(app).get('/a2a/stream/test-task-123');

      req.on('response', (res) => {
        // Check SSE headers are set
        expect(res.headers['content-type']).toBe('text/event-stream');
        expect(res.headers['cache-control']).toBe('no-cache');
        expect(res.headers['connection']).toBe('keep-alive');

        // Abort the request after verifying headers
        req.abort();
        done();
      });

      req.on('error', (err: any) => {
        // Abort error is expected
        if (err.code === 'ECONNRESET' || err.message.includes('aborted')) {
          return;
        }
        done(err);
      });
    });

    it('returns 404 for missing taskId', async () => {
      // Test the route pattern by calling without taskId
      const response = await request(app).get('/a2a/stream/');

      expect(response.status).toBe(404);
    });
  });

  describe('Route Coexistence', () => {
    it('A2A and MCP routes both respond correctly', async () => {
      // Test MCP route
      const mcpResponse = await request(app)
        .post('/mcp')
        .send({ jsonrpc: '2.0', method: 'test' });

      expect(mcpResponse.status).toBe(200);
      expect(mcpResponse.body).toMatchObject({
        jsonrpc: '2.0',
        result: { service: 'mcp' },
      });

      // Test A2A Agent Card route
      const agentCardResponse = await request(app).get('/.well-known/agent.json');

      expect(agentCardResponse.status).toBe(200);
      expect(agentCardResponse.body.name).toBe('ZKProofport Prover Agent');

      // Test A2A JSON-RPC route
      const a2aResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/send',
          params: { skill: 'verify_proof' },
        });

      expect(a2aResponse.status).toBe(200);
      expect(a2aResponse.body.result).toBeDefined();
    });
  });
});
