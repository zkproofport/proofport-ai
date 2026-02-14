import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { getAgentCardHandler } from '../../src/a2a/agentCard.js';
import { createA2aHandler } from '../../src/a2a/taskHandler.js';
import { TaskStore } from '../../src/a2a/taskStore.js';
import { TaskEventEmitter } from '../../src/a2a/streaming.js';
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
      proverUrl: '',
      bbPath: 'bb',
      nargoPath: 'nargo',
      circuitsDir: '/tmp/circuits',
      circuitsRepoUrl: 'https://github.com/example/circuits',
      redisUrl: 'redis://localhost:6379',
      baseRpcUrl: 'https://base.example.com',
      easGraphqlEndpoint: 'https://eas.example.com',
      chainRpcUrl: 'https://chain.example.com',
      nullifierRegistryAddress: '0x1234567890123456789012345678901234567890',
      proverPrivateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      paymentMode: 'disabled',
      a2aBaseUrl: 'https://test.example.com',
      websiteUrl: 'https://zkproofport.app',
      agentVersion: '1.0.0',
      paymentPayTo: '',
      paymentFacilitatorUrl: '',
      paymentProofPrice: '$0.10',
      privyAppId: '',
      privyApiSecret: '',
      privyApiUrl: '',
      signPageUrl: '',
      signingTtlSeconds: 300,
      teeMode: 'disabled',
      enclaveCid: undefined,
      enclavePort: 5000,
      teeAttestationEnabled: false,
      erc8004IdentityAddress: '',
      erc8004ReputationAddress: '',
      erc8004ValidationAddress: '',
      settlementChainRpcUrl: '',
      settlementPrivateKey: '',
      settlementOperatorAddress: '',
      settlementUsdcAddress: '',
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
    app.get('/.well-known/agent-card.json', getAgentCardHandler(mockConfig));
    app.post('/a2a', createA2aHandler({ taskStore, taskEventEmitter }));

    // Add MCP route for coexistence test
    app.post('/mcp', (_req, res) => {
      res.json({ jsonrpc: '2.0', result: { service: 'mcp' } });
    });
  });

  describe('GET /.well-known/agent-card.json', () => {
    it('returns valid Agent Card with Content-Type application/json', async () => {
      const response = await request(app).get('/.well-known/agent-card.json');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toMatchObject({
        name: 'ZKProofport Prover Agent',
        description: expect.any(String),
        url: 'https://test.example.com',
        version: '1.0.0',
        protocolVersion: '0.3.0',
        preferredTransport: 'JSONRPC',
        provider: {
          organization: 'ZKProofport',
          url: 'https://zkproofport.app',
        },
        capabilities: {
          streaming: true,
          pushNotifications: false,
          stateTransitionHistory: true,
        },
        skills: expect.arrayContaining([
          expect.objectContaining({
            id: 'generate_proof',
            name: 'Generate ZK Proof',
            tags: expect.any(Array),
            examples: expect.any(Array),
          }),
        ]),
        securitySchemes: {
          x402: { scheme: 'x402', description: expect.any(String) },
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
    it('returns task for valid tasks/get request', async () => {
      // First create a task directly via taskStore
      const userMessage = {
        role: 'user' as const,
        parts: [{ kind: 'data' as const, mimeType: 'application/json', data: { skill: 'generate_proof', circuitId: 'coinbase_attestation' } }],
        timestamp: new Date().toISOString(),
      };
      const task = await taskStore.createTask('generate_proof', { circuitId: 'coinbase_attestation' }, userMessage);

      // Now retrieve it via tasks/get
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/get',
          params: {
            id: task.id,
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          id: task.id,
          status: {
            state: 'queued',
          },
          skill: 'generate_proof',
          kind: 'task',
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
          message: expect.stringContaining('Method not found'),
        },
      });
    });

    it('returns error for tasks/cancel on non-existent task', async () => {
      const response = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/cancel',
          params: {
            id: 'non-existent-task-id',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32001,
          message: 'Task not found',
        },
      });
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
      const agentCardResponse = await request(app).get('/.well-known/agent-card.json');

      expect(agentCardResponse.status).toBe(200);
      expect(agentCardResponse.body.name).toBe('ZKProofport Prover Agent');

      // Test A2A JSON-RPC route (use tasks/get which is non-blocking)
      const userMessage = {
        role: 'user' as const,
        parts: [{ kind: 'text' as const, text: 'verify proof' }],
        timestamp: new Date().toISOString(),
      };
      const task = await taskStore.createTask('verify_proof', {}, userMessage);

      const a2aResponse = await request(app)
        .post('/a2a')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/get',
          params: { id: task.id },
        });

      expect(a2aResponse.status).toBe(200);
      expect(a2aResponse.body.result).toBeDefined();
    });
  });
});
