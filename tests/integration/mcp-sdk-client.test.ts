/**
 * MCP SDK Client Integration Tests
 *
 * Tests the proofport-ai MCP server using the REAL @modelcontextprotocol/sdk
 * client library (Client + StreamableHTTPClientTransport), NOT supertest or
 * raw HTTP.
 *
 * The server is started with app.listen() on a random port. The MCP client
 * connects to http://localhost:${port}/mcp.
 *
 * All mocks are for EXTERNAL dependencies only (Redis, bb, ethers) -- never
 * for the MCP protocol layer itself.
 *
 * MCP server exposes exactly 2 tools: prove, get_supported_circuits
 * and 1 prompt: proof_generation_flow
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../src/index.js';
import type { Config } from '../../src/config/index.js';

// ─── Mock modules (external dependencies only) ────────────────────────────

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

const { _redisStore, _redisListStore } = vi.hoisted(() => ({
  _redisStore: new Map<string, string>(),
  _redisListStore: new Map<string, string[]>(),
}));

vi.mock('ioredis', () => {
  const mockRedis: any = {
    get: vi.fn((key: string) => Promise.resolve(_redisStore.get(key) || null)),
    set: vi.fn((...args: any[]) => {
      _redisStore.set(args[0], args[1]);
      return Promise.resolve('OK');
    }),
    del: vi.fn((key: string) => {
      _redisStore.delete(key);
      return Promise.resolve(1);
    }),
    lpush: vi.fn((key: string, value: string) => {
      const list = _redisListStore.get(key) || [];
      list.push(value);
      _redisListStore.set(key, list);
      return Promise.resolve(list.length);
    }),
    ttl: vi.fn().mockResolvedValue(300),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue('OK'),
    status: 'ready',
  };
  return { default: vi.fn(() => mockRedis), Redis: vi.fn(() => mockRedis) };
});

vi.mock('../../src/prover/bbProver.js', () => ({
  BbProver: vi.fn().mockImplementation(() => ({
    prove: vi.fn().mockResolvedValue({
      proof: '0xmockproof',
      publicInputs: '0xmockpublic',
      proofWithInputs: '0xmockproofpublic',
    }),
  })),
}));

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
  computeSignalHash: vi.fn().mockReturnValue(new Uint8Array(32).fill(1)),
}));

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

vi.mock('../../src/circuit/artifactManager.js', () => ({
  ensureArtifacts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/identity/autoRegister.js', () => ({
  ensureAgentRegistered: vi.fn().mockResolvedValue(123456n),
}));

vi.mock('../../src/identity/reputation.js', () => ({
  handleProofCompleted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/prover/verifier.js', () => ({
  verifyOnChain: vi.fn().mockResolvedValue(true),
}));

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

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTestConfig(overrides?: Partial<Config>): Config {
  return {
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
    a2aBaseUrl: 'http://localhost:0',
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
    ...overrides,
  };
}

/**
 * Create a fresh MCP Client + StreamableHTTPClientTransport, connect, and return both.
 * Each call creates a new client because the server is stateless (no session).
 */
async function createMcpClient(port: number): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
  );
  await client.connect(transport);
  return { client, transport };
}

/**
 * Parse the text content from a callTool result into JSON.
 * Returns the last text content item parsed as JSON, or the raw text if not JSON.
 */
function parseToolResult(result: any): any {
  const textContents = result.content?.filter((c: any) => c.type === 'text');
  if (!textContents || textContents.length === 0) return null;
  try {
    return JSON.parse(textContents[textContents.length - 1].text);
  } catch {
    return { rawText: textContents[textContents.length - 1].text };
  }
}

// ─── Test suite ───────────────────────────────────────────────────────────

describe('MCP SDK Client Integration', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    // Find a free port
    port = await new Promise<number>((resolve) => {
      const tmp = http.createServer();
      tmp.listen(0, () => {
        const addr = tmp.address() as { port: number };
        tmp.close(() => resolve(addr.port));
      });
    });

    // Create app with correct config
    const config = makeTestConfig({ a2aBaseUrl: `http://localhost:${port}` });
    const { app } = createApp(config, 123456n);

    // Start real HTTP server
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, () => resolve(s));
    });
  }, 15000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  beforeEach(() => {
    _redisStore.clear();
    _redisListStore.clear();
  });

  // ── 1. Initialize and List Tools ────────────────────────────────────────

  describe('Initialize and List Tools', () => {
    it('client.connect() should succeed (MCP handshake)', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        expect(client).toBeDefined();
        const serverVersion = client.getServerVersion();
        expect(serverVersion).toBeDefined();
        expect(serverVersion!.name).toBe('zkproofport-prover');
      } finally {
        await transport.close();
      }
    });

    it('client.listTools() should return exactly 2 tools: prove and get_supported_circuits', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listTools();
        expect(result.tools).toBeDefined();
        expect(result.tools).toHaveLength(2);

        const toolNames = result.tools.map((t) => t.name).sort();
        expect(toolNames).toEqual(['get_supported_circuits', 'prove']);
      } finally {
        await transport.close();
      }
    });

    it('each tool should have inputSchema with type "object" and properties', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listTools();
        for (const tool of result.tools) {
          expect(tool.inputSchema).toBeDefined();
          expect(tool.inputSchema.type).toBe('object');
          expect(tool.inputSchema.properties).toBeDefined();
          expect(typeof tool.inputSchema.properties).toBe('object');
        }
      } finally {
        await transport.close();
      }
    });

    it('prove tool has required fields: circuit and inputs', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listTools();
        const tool = result.tools.find((t) => t.name === 'prove');
        expect(tool).toBeDefined();
        expect(tool!.inputSchema.required).toBeDefined();
        expect(tool!.inputSchema.required).toContain('circuit');
        expect(tool!.inputSchema.required).toContain('inputs');
      } finally {
        await transport.close();
      }
    });

    it('get_supported_circuits tool has no required fields', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listTools();
        const tool = result.tools.find((t) => t.name === 'get_supported_circuits');
        expect(tool).toBeDefined();
        const required = tool!.inputSchema.required || [];
        expect(required).toHaveLength(0);
      } finally {
        await transport.close();
      }
    });
  });

  // ── 2. callTool — get_supported_circuits ────────────────────────────────

  describe('callTool — get_supported_circuits', () => {
    it('returns isError: false (or undefined) with circuits array', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({ name: 'get_supported_circuits', arguments: {} });
        expect(result.isError).toBeFalsy();

        // get_supported_circuits returns two text content items: guidance + JSON
        const textContents = result.content?.filter((c: any) => c.type === 'text');
        expect(textContents).toBeDefined();
        expect(textContents!.length).toBeGreaterThanOrEqual(1);

        // Parse the last text as JSON (the circuits data)
        const parsed = parseToolResult(result);
        expect(parsed).toBeDefined();
        expect(parsed.circuits).toBeDefined();
        expect(Array.isArray(parsed.circuits)).toBe(true);
      } finally {
        await transport.close();
      }
    });

    it('circuits array contains coinbase_attestation and coinbase_country_attestation', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({ name: 'get_supported_circuits', arguments: {} });
        const parsed = parseToolResult(result);
        const circuitIds = parsed.circuits.map((c: any) => c.id);
        expect(circuitIds).toContain('coinbase_attestation');
        expect(circuitIds).toContain('coinbase_country_attestation');
      } finally {
        await transport.close();
      }
    });

    it('each circuit has id, displayName, and description', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({ name: 'get_supported_circuits', arguments: {} });
        const parsed = parseToolResult(result);
        for (const circuit of parsed.circuits) {
          expect(circuit).toHaveProperty('id');
          expect(circuit).toHaveProperty('displayName');
          expect(circuit).toHaveProperty('description');
        }
      } finally {
        await transport.close();
      }
    });

    it('returns guidance text as first content item', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({ name: 'get_supported_circuits', arguments: {} });
        const textContents = result.content?.filter((c: any) => c.type === 'text');
        expect(textContents!.length).toBeGreaterThanOrEqual(2);
        // First content item should be guidance text
        expect(typeof (textContents![0] as any).text).toBe('string');
        expect((textContents![0] as any).text.length).toBeGreaterThan(0);
      } finally {
        await transport.close();
      }
    });
  });

  // ── 3. callTool — prove ──────────────────────────────────────────────────

  describe('callTool — prove', () => {
    it('returns redirect message with REST endpoint info', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({
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
        });

        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed).toBeDefined();
        // prove returns a redirect message to the REST endpoint
        expect(parsed.rest_endpoint || parsed.message).toBeDefined();
      } finally {
        await transport.close();
      }
    });

    it('prove with coinbase_country circuit also succeeds', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({
          name: 'prove',
          arguments: {
            circuit: 'coinbase_country',
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
              country_list: ['US', 'KR'],
              is_included: true,
            },
          },
        });

        expect(result.isError).toBeFalsy();
      } finally {
        await transport.close();
      }
    });
  });

  // ── 4. Prompts ──────────────────────────────────────────────────────────

  describe('Prompts', () => {
    it('client.listPrompts() contains proof_generation_flow', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listPrompts();
        expect(result.prompts).toBeDefined();
        expect(Array.isArray(result.prompts)).toBe(true);
        expect(result.prompts.length).toBeGreaterThan(0);

        const promptNames = result.prompts.map((p) => p.name);
        expect(promptNames).toContain('proof_generation_flow');
      } finally {
        await transport.close();
      }
    });

    it('client.getPrompt({ name: "proof_generation_flow" }) returns messages with instructions', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.getPrompt({ name: 'proof_generation_flow' });
        expect(result.messages).toBeDefined();
        expect(Array.isArray(result.messages)).toBe(true);
        expect(result.messages.length).toBeGreaterThan(0);

        const firstMessage = result.messages[0];
        expect(firstMessage.role).toBe('user');
        expect(firstMessage.content.type).toBe('text');
        const text = (firstMessage.content as any).text as string;
        // The prompt references the x402 flow and REST endpoint
        expect(text).toContain('get_supported_circuits');
        expect(text).toContain('prove');
      } finally {
        await transport.close();
      }
    });

    it('proof_generation_flow prompt content references guide_url', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.getPrompt({ name: 'proof_generation_flow' });
        const text = (result.messages[0].content as any).text as string;
        expect(text).toContain('guide_url');
      } finally {
        await transport.close();
      }
    });
  });

  // ── 5. Full Session Flow ─────────────────────────────────────────────────

  describe('Full Session Flow', () => {
    it('get_supported_circuits -> prove (REST redirect)', async () => {
      // Step 1: discover circuits
      const { client: c1, transport: t1 } = await createMcpClient(port);
      let circuitIds: string[];
      try {
        const circuitsResult = await c1.callTool({ name: 'get_supported_circuits', arguments: {} });
        expect(circuitsResult.isError).toBeFalsy();
        const parsed = parseToolResult(circuitsResult);
        circuitIds = parsed.circuits.map((c: any) => c.id);
        expect(circuitIds).toContain('coinbase_attestation');
      } finally {
        await t1.close();
      }

      // Step 2: prove using discovered circuit alias
      const { client: c2, transport: t2 } = await createMcpClient(port);
      try {
        const proveResult = await c2.callTool({
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
        });
        expect(proveResult.isError).toBeFalsy();
        const parsed = parseToolResult(proveResult);
        // prove redirects to REST — should contain endpoint or message
        expect(parsed.rest_endpoint || parsed.message || parsed.staging_url).toBeDefined();
      } finally {
        await t2.close();
      }
    });
  });
});
