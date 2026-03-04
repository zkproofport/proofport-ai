/**
 * MCP Endpoint E2E Tests
 * Tests the full HTTP endpoint flow for MCP (POST /mcp)
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import type { Config } from '../../src/config/index.js';
import { loadConfig } from '../../src/config/index.js';

// ─── Mock modules ─────────────────────────────────────────────────────────

// Mock x402 payment middleware
vi.mock('@x402/express', () => ({
  paymentMiddleware: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  x402ResourceServer: vi.fn().mockImplementation(() => ({
    register: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('@x402/evm/exact/server', () => ({
  ExactEvmScheme: vi.fn(),
}));

vi.mock('@x402/core/server', () => ({
  HTTPFacilitatorClient: vi.fn(),
}));

// Mock ioredis
vi.mock('ioredis', () => {
  const store = new Map<string, string>();
  const mockRedis = {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) || null)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    rpop: vi.fn().mockResolvedValue(null),
    rpush: vi.fn().mockResolvedValue(1),
    lpush: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue('OK'),
    status: 'ready',
  };
  return { default: vi.fn(() => mockRedis), Redis: vi.fn(() => mockRedis) };
});

// Mock BbProver
vi.mock('../../src/prover/bbProver.js', () => ({
  BbProver: vi.fn().mockImplementation(() => ({
    prove: vi.fn().mockResolvedValue({
      proof: '0xmockproof',
      publicInputs: '0xmockpublic',
      proofWithInputs: '0xmockproofpublic',
    }),
  })),
}));

// Mock inputBuilder
vi.mock('../../src/input/inputBuilder.js', () => ({
  computeCircuitParams: vi.fn().mockResolvedValue({
    signalHash: new Uint8Array(32).fill(1),
    merkleRoot: '0x' + '22'.repeat(32),
    scopeBytes: new Uint8Array(32).fill(3),
    nullifierBytes: new Uint8Array(32).fill(4),
    userAddress: '0x' + '55'.repeat(20),
    userSignature: '0x' + '66'.repeat(65),
    userPubkeyX: '0x' + '77'.repeat(32),
    userPubkeyY: '0x' + '88'.repeat(32),
    rawTxBytes: Array(200).fill(9),
    txLength: 200,
    attesterPubkeyX: '0x' + 'aa'.repeat(32),
    attesterPubkeyY: '0x' + 'bb'.repeat(32),
    merkleProof: ['0x' + 'cc'.repeat(32)],
    merkleLeafIndex: 0,
    merkleDepth: 1,
  }),
}));

// Mock ethers
vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
      getNetwork: vi.fn().mockResolvedValue({ chainId: 84532n }),
      getLogs: vi.fn().mockResolvedValue([]),
    })),
    Wallet: vi.fn().mockImplementation((_pk: string, prov: any) => ({
      address: '0x1234567890123456789012345678901234567890',
      provider: prov,
    })),
    Contract: vi.fn().mockImplementation(() => ({
      verify: vi.fn().mockResolvedValue(true),
      register: vi.fn().mockResolvedValue({ wait: vi.fn().mockResolvedValue({ logs: [] }) }),
      balanceOf: vi.fn().mockResolvedValue(0n),
      incrementScore: vi.fn().mockResolvedValue({ wait: vi.fn().mockResolvedValue({}) }),
    })),
    hexlify: vi.fn((bytes: Uint8Array) => '0x' + Buffer.from(bytes).toString('hex')),
    encodeBytes32String: vi.fn((str: string) => '0x' + Buffer.from(str).toString('hex').padEnd(64, '0')),
    id: vi.fn((str: string) => '0x' + Buffer.from(str).toString('hex').padEnd(64, '0')),
    getAddress: vi.fn((addr: string) => addr),
    getBytes: vi.fn((hex: string) => new Uint8Array(Buffer.from(hex.replace('0x', ''), 'hex'))),
    keccak256: vi.fn(() => '0x' + '11'.repeat(32)),
    randomBytes: vi.fn((n: number) => new Uint8Array(n).fill(0xab)),
    toUtf8Bytes: vi.fn((str: string) => Buffer.from(str, 'utf8')),
    verifyMessage: vi.fn(() => '0x1234567890123456789012345678901234567890'),
  },
}));

// Mock loadConfig — MCP tool handlers call loadConfig() internally
vi.mock('../../src/config/index.js', () => ({
  loadConfig: vi.fn(() => ({
    port: 4002,
    nodeEnv: 'test',
    proverUrl: '',
    bbPath: '/usr/local/bin/bb',
    nargoPath: '/usr/local/bin/nargo',
    circuitsDir: '/circuits',
    circuitsRepoUrl: 'https://example.com/circuits',
    redisUrl: 'redis://localhost:6379',
    baseRpcUrl: 'https://base-rpc.example.com',
    easGraphqlEndpoint: 'https://eas.example.com',
    chainRpcUrl: 'https://chain.example.com',
    nullifierRegistryAddress: '0x' + '11'.repeat(20),
    proverPrivateKey: '0x' + 'ab'.repeat(32),
    paymentMode: 'disabled',
    a2aBaseUrl: 'https://a2a.example.com',
    agentVersion: '1.0.0',
    paymentPayTo: '',
    paymentProofPrice: '$0.10',
    teeMode: 'disabled',
    enclaveCid: undefined,
    enclavePort: 5000,
    teeAttestationEnabled: false,
    erc8004IdentityAddress: '',
    erc8004ReputationAddress: '',
    erc8004ValidationAddress: '',
    websiteUrl: 'https://zkproofport.com',
    openaiApiKey: '',
    geminiApiKey: '',
    phoenixCollectorEndpoint: '',
  })),
}));

// Mock circuit artifact manager
vi.mock('../../src/circuit/artifactManager.js', () => ({
  ensureArtifacts: vi.fn().mockResolvedValue(undefined),
}));

// Mock identity
vi.mock('../../src/identity/autoRegister.js', () => ({
  ensureAgentRegistered: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/identity/reputation.js', () => ({
  handleProofCompleted: vi.fn().mockResolvedValue(undefined),
}));

// Mock verifier — must return { isValid, verifierAddress } shape
vi.mock('../../src/prover/verifier.js', () => ({
  verifyOnChain: vi.fn().mockResolvedValue({
    isValid: true,
    verifierAddress: '0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c',
  }),
}));

// Mock contracts config
vi.mock('../../src/config/contracts.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config/contracts.js')>('../../src/config/contracts.js');
  return {
    ...actual,
    ERC8004_ADDRESSES: {
      mainnet: {
        identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
      },
      sepolia: {
        identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      },
    },
  };
});

// ─── Test suite ───────────────────────────────────────────────────────────

/**
 * Parse SSE response text to extract JSON-RPC message
 * MCP StreamableHTTP sends responses as Server-Sent Events
 */
function parseSSEResponse(text: string): any {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.substring(6));
    }
  }
  return null;
}

describe('MCP Endpoint E2E', () => {
  let app: any;

  beforeEach(() => {
    const testConfig: Config = {
      port: 4002,
      nodeEnv: 'test',
      websiteUrl: 'https://zkproofport.com',
      proverUrl: '',
      bbPath: '/usr/local/bin/bb',
      nargoPath: '/usr/local/bin/nargo',
      circuitsDir: '/circuits',
      circuitsRepoUrl: 'https://example.com/circuits',
      redisUrl: 'redis://localhost:6379',
      baseRpcUrl: 'https://base-rpc.example.com',
      easGraphqlEndpoint: 'https://eas.example.com',
      chainRpcUrl: 'https://chain.example.com',
      nullifierRegistryAddress: '0x' + '11'.repeat(20),
      proverPrivateKey: '0x' + 'ab'.repeat(32),
      paymentMode: 'disabled' as const,
      a2aBaseUrl: 'https://a2a.example.com',
      agentVersion: '1.0.0',
      paymentPayTo: '',
      paymentProofPrice: '$0.10',
      teeMode: 'disabled' as const,
      enclaveCid: undefined,
      enclavePort: 5000,
      teeAttestationEnabled: false,
      erc8004IdentityAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      erc8004ReputationAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      erc8004ValidationAddress: '',
      openaiApiKey: '',
      geminiApiKey: '',
      phoenixCollectorEndpoint: '',
    };

    const appBundle = createApp(testConfig);
    app = appBundle.app;
  });

  describe('POST /mcp', () => {
    it('should handle MCP initialize request', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
              name: 'test-client',
              version: '1.0.0',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: expect.any(String),
          capabilities: expect.any(Object),
          serverInfo: expect.objectContaining({
            name: 'zkproofport-prover',
            version: expect.any(String),
          }),
        },
      });
    });

    it('should handle tools/list request', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({
              name: 'prove',
              description: expect.any(String),
              inputSchema: expect.any(Object),
            }),
            expect.objectContaining({
              name: 'get_supported_circuits',
              description: expect.any(String),
              inputSchema: expect.any(Object),
            }),
          ]),
        },
      });

      // Verify all two tools are present
      const tools = data.result.tools;
      expect(tools).toHaveLength(2);
      expect(tools.map((t: any) => t.name).sort()).toEqual([
        'get_supported_circuits',
        'prove',
      ]);
    });

    it('should reject malformed MCP request (invalid JSON-RPC)', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          // Missing jsonrpc field
          id: 1,
          method: 'initialize',
          params: {},
        });

      // Malformed JSON-RPC returns 400
      expect(response.status).toBe(400);
    });

    it('should reject invalid method', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'invalid_method_does_not_exist',
          params: {},
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({
        jsonrpc: '2.0',
        error: {
          code: -32601,
          message: expect.stringContaining('Method not found'),
        },
      });
    });

    it('should handle tools/call for get_supported_circuits', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'get_supported_circuits',
            arguments: {},
          },
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({
        jsonrpc: '2.0',
        id: 3,
        result: {
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'text',
              text: expect.stringContaining('coinbase_attestation'),
            }),
          ]),
        },
      });
    });

    it('should handle tools/call for unknown tool (verify_proof does not exist in remote MCP)', async () => {
      // verify_proof is only in the local MCP server (packages/mcp-server), not the remote MCP server.
      // The remote MCP server only has: prove, get_supported_circuits.
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: {
            name: 'verify_proof',
            arguments: {
              circuitId: 'coinbase_attestation',
              proof: '0xaabb',
              publicInputs: ['0x' + 'cc'.repeat(32)],
              chainId: '84532',
            },
          },
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({
        jsonrpc: '2.0',
        id: 10,
      });

      // Unknown tool returns either a JSON-RPC error or isError: true
      if (data.error) {
        expect(data.error).toMatchObject({
          code: expect.any(Number),
          message: expect.any(String),
        });
      } else {
        expect(data.result.isError).toBe(true);
      }
    });

    it('should handle tools/call for prove — returns REST endpoint redirect message', async () => {
      // The prove tool redirects to the REST endpoint due to MCP timeout limitations
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 12,
          method: 'tools/call',
          params: {
            name: 'prove',
            arguments: {
              circuit: 'coinbase_kyc',
              inputs: {
                signal_hash: '0x' + '11'.repeat(32),
                nullifier: '0x' + '22'.repeat(32),
                scope_bytes: '0x' + '33'.repeat(32),
                merkle_root: '0x' + '44'.repeat(32),
                user_address: '0x' + '55'.repeat(20),
                signature: '0x' + '66'.repeat(65),
                user_pubkey_x: '0x' + '77'.repeat(32),
                user_pubkey_y: '0x' + '88'.repeat(32),
                raw_transaction: '0x' + '99'.repeat(100),
                tx_length: 100,
                coinbase_attester_pubkey_x: '0x' + 'aa'.repeat(32),
                coinbase_attester_pubkey_y: '0x' + 'bb'.repeat(32),
                merkle_proof: ['0x' + 'cc'.repeat(32)],
                leaf_index: 0,
                depth: 1,
              },
            },
          },
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({
        jsonrpc: '2.0',
        id: 12,
      });

      // prove tool returns a redirect message with REST endpoint info
      const result = data.result;
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
          }),
        ]),
      );

      const textContents = result.content.filter((c: any) => c.type === 'text');
      const parsed = JSON.parse(textContents[textContents.length - 1].text);
      expect(parsed).toHaveProperty('rest_endpoint');
    });

    it('should handle tools/call for unknown tool', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 14,
          method: 'tools/call',
          params: {
            name: 'nonexistent_tool',
            arguments: {},
          },
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({
        jsonrpc: '2.0',
        id: 14,
      });

      // MCP SDK returns a result with isError: true for unknown tools,
      // not a JSON-RPC error object
      if (data.error) {
        // Some MCP SDK versions return JSON-RPC error
        expect(data.error).toMatchObject({
          code: expect.any(Number),
          message: expect.any(String),
        });
      } else {
        // MCP SDK returns result with isError flag
        expect(data.result).toBeDefined();
        expect(data.result.isError).toBe(true);
      }
    });
  });

  describe('GET /mcp', () => {
    it('should return 405 for GET /mcp', async () => {
      const response = await request(app).get('/mcp');

      expect(response.status).toBe(405);
      expect(response.body).toMatchObject({
        error: expect.stringContaining('SSE not supported'),
      });
    });
  });

  describe('DELETE /mcp', () => {
    it('should return 405 for DELETE /mcp', async () => {
      const response = await request(app).delete('/mcp');

      expect(response.status).toBe(405);
      expect(response.body).toMatchObject({
        error: expect.stringContaining('Session management not supported'),
      });
    });
  });

  describe('MCP Discovery', () => {
    it('GET /.well-known/mcp.json should return MCP discovery', async () => {
      const response = await request(app).get('/.well-known/mcp.json');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);

      const body = response.body;
      expect(body).toHaveProperty('protocolVersion');
      expect(body).toHaveProperty('serverInfo');
      expect(body.serverInfo).toMatchObject({
        name: expect.any(String),
        version: expect.any(String),
      });
      expect(body).toHaveProperty('tools');
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.tools.map((t: any) => t.name).sort()).toEqual([
        'get_supported_circuits',
        'prove',
      ]);
    });
  });

  describe('prompts/list', () => {
    it('should handle prompts/list request and include proof_generation_flow prompt', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 30,
          method: 'prompts/list',
          params: {},
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({
        jsonrpc: '2.0',
        id: 30,
        result: {
          prompts: expect.arrayContaining([
            expect.objectContaining({ name: 'proof_generation_flow' }),
          ]),
        },
      });
    });

    it('should return proof_generation_flow prompt content via prompts/get', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 31,
          method: 'prompts/get',
          params: { name: 'proof_generation_flow', arguments: {} },
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      expect(data).toMatchObject({ jsonrpc: '2.0', id: 31 });
      expect(data.result).toBeDefined();
      expect(data.result.messages).toBeInstanceOf(Array);
      expect(data.result.messages.length).toBeGreaterThan(0);

      const firstMessage = data.result.messages[0];
      expect(firstMessage.role).toBe('user');
      expect(firstMessage.content.type).toBe('text');
      expect(firstMessage.content.text).toContain('get_supported_circuits');
      expect(firstMessage.content.text).toContain('prove');
    });
  });

  describe('tools/list — inputSchema structure validation', () => {
    it('should have correct inputSchema structure for each tool', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 40,
          method: 'tools/list',
          params: {},
        });

      expect(response.status).toBe(200);

      const data = parseSSEResponse(response.text);
      const tools: any[] = data.result.tools;

      // Every tool must have a valid inputSchema
      for (const tool of tools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool.inputSchema).toHaveProperty('type', 'object');
        expect(tool.inputSchema).toHaveProperty('properties');
        expect(typeof tool.inputSchema.properties).toBe('object');
      }

      // Spot-check prove tool schema
      const prove = tools.find((t: any) => t.name === 'prove');
      expect(prove).toBeDefined();
      expect(prove.inputSchema.properties).toHaveProperty('circuit');
      expect(prove.inputSchema.properties).toHaveProperty('inputs');

      const getSupportedCircuits = tools.find((t: any) => t.name === 'get_supported_circuits');
      expect(getSupportedCircuits).toBeDefined();
      expect(getSupportedCircuits.inputSchema).toHaveProperty('type', 'object');
    });
  });
});
