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
    paymentFacilitatorUrl: '',
    paymentProofPrice: '$0.10',
    privyAppId: '',
    privyApiSecret: '',
    privyApiUrl: '',
    signPageUrl: 'https://sign.zkproofport.app',
    signingTtlSeconds: 300,
    teeMode: 'disabled' as const,
    enclaveCid: undefined,
    enclavePort: 5000,
    teeAttestationEnabled: false,
    erc8004IdentityAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    erc8004ReputationAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    settlementChainRpcUrl: '',
    settlementPrivateKey: '',
    settlementOperatorAddress: '',
    settlementUsdcAddress: '',
    openaiApiKey: '',
    geminiApiKey: '',
    phoenixCollectorEndpoint: '',
    erc8004ValidationAddress: '',
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
 */
function parseToolResult(result: any): any {
  const textContents = result.content?.filter((c: any) => c.type === 'text');
  if (!textContents || textContents.length === 0) return null;
  return JSON.parse(textContents[textContents.length - 1].text);
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
        // If connect() succeeds without throwing, handshake is complete
        expect(client).toBeDefined();
        const serverVersion = client.getServerVersion();
        expect(serverVersion).toBeDefined();
        expect(serverVersion!.name).toBe('zkproofport-prover');
      } finally {
        await transport.close();
      }
    });

    it('client.listTools() should return all 6 tools', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listTools();
        expect(result.tools).toBeDefined();
        expect(result.tools).toHaveLength(6);

        const toolNames = result.tools.map((t) => t.name).sort();
        expect(toolNames).toEqual([
          'check_status',
          'generate_proof',
          'get_supported_circuits',
          'request_payment',
          'request_signing',
          'verify_proof',
        ]);
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
  });

  // ── 2. callTool — get_supported_circuits ────────────────────────────────

  describe('callTool — get_supported_circuits', () => {
    it('returns isError: false (or undefined) with circuits array', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({ name: 'get_supported_circuits', arguments: {} });
        expect(result.isError).toBeFalsy();

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

    it('each circuit has circuitId, displayName, and description', async () => {
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
  });

  // ── 3. callTool — request_signing ───────────────────────────────────────

  describe('callTool — request_signing', () => {
    it('with valid circuitId and scope returns requestId, signingUrl, expiresAt', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({
          name: 'request_signing',
          arguments: { circuitId: 'coinbase_attestation', scope: 'test.com' },
        });

        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed).toHaveProperty('requestId');
        expect(typeof parsed.requestId).toBe('string');
        expect(parsed).toHaveProperty('signingUrl');
        expect(parsed.signingUrl).toContain('/s/');
        expect(parsed).toHaveProperty('expiresAt');
      } finally {
        await transport.close();
      }
    });

    it('with missing circuitId returns isError: true', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        // Zod validation will reject missing required field
        let gotError = false;
        try {
          const result = await client.callTool({
            name: 'request_signing',
            arguments: { scope: 'test.com' },
          });
          // If it doesn't throw, check isError
          gotError = !!result.isError;
        } catch {
          // MCP SDK may throw for validation errors
          gotError = true;
        }
        expect(gotError).toBe(true);
      } finally {
        await transport.close();
      }
    });

    it('with missing scope returns isError: true', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        let gotError = false;
        try {
          const result = await client.callTool({
            name: 'request_signing',
            arguments: { circuitId: 'coinbase_attestation' },
          });
          gotError = !!result.isError;
        } catch {
          gotError = true;
        }
        expect(gotError).toBe(true);
      } finally {
        await transport.close();
      }
    });

    it('with invalid circuitId returns isError: true with "Unknown circuit"', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({
          name: 'request_signing',
          arguments: { circuitId: 'nonexistent_circuit', scope: 'test.com' },
        });

        expect(result.isError).toBe(true);
        const parsed = parseToolResult(result);
        expect(parsed.error).toContain('Unknown circuit');
      } finally {
        await transport.close();
      }
    });
  });

  // ── 4. callTool — check_status ──────────────────────────────────────────

  describe('callTool — check_status', () => {
    it('with valid requestId (after request_signing) returns status info with phase', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        // First create a signing request
        const signingResult = await client.callTool({
          name: 'request_signing',
          arguments: { circuitId: 'coinbase_attestation', scope: 'test.com' },
        });
        const signingData = parseToolResult(signingResult);
        const requestId = signingData.requestId;
        expect(requestId).toBeDefined();

        // Now check status with a new client (stateless server)
        const { client: client2, transport: transport2 } = await createMcpClient(port);
        try {
          const statusResult = await client2.callTool({
            name: 'check_status',
            arguments: { requestId },
          });

          expect(statusResult.isError).toBeFalsy();
          const statusData = parseToolResult(statusResult);
          expect(statusData).toHaveProperty('phase');
          expect(statusData.phase).toBe('signing');
        } finally {
          await transport2.close();
        }
      } finally {
        await transport.close();
      }
    });

    it('with unknown requestId returns isError: true', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({
          name: 'check_status',
          arguments: { requestId: 'non-existent-request-id-xyz' },
        });

        expect(result.isError).toBe(true);
        const parsed = parseToolResult(result);
        expect(parsed.error).toBeDefined();
      } finally {
        await transport.close();
      }
    });
  });

  // ── 5. callTool — request_payment ───────────────────────────────────────

  describe('callTool — request_payment', () => {
    it('with unknown requestId returns isError: true', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({
          name: 'request_payment',
          arguments: { requestId: 'unknown-payment-request-id' },
        });

        expect(result.isError).toBe(true);
      } finally {
        await transport.close();
      }
    });

    it('with disabled payment mode returns error about payment', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        // First create a signing request to get a valid requestId
        const signingResult = await client.callTool({
          name: 'request_signing',
          arguments: { circuitId: 'coinbase_attestation', scope: 'test.com' },
        });
        const requestId = parseToolResult(signingResult).requestId;

        // Now request payment (payment is disabled in test config)
        const { client: client2, transport: transport2 } = await createMcpClient(port);
        try {
          const result = await client2.callTool({
            name: 'request_payment',
            arguments: { requestId },
          });

          expect(result.isError).toBe(true);
          const parsed = parseToolResult(result);
          expect(parsed.error).toBeDefined();
        } finally {
          await transport2.close();
        }
      } finally {
        await transport.close();
      }
    });
  });

  // ── 6. callTool — generate_proof ────────────────────────────────────────

  describe('callTool — generate_proof', () => {
    it('with direct signature returns proof, publicInputs, proofId, nullifier', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({
          name: 'generate_proof',
          arguments: {
            circuitId: 'coinbase_attestation',
            scope: 'test.com',
            address: '0x' + 'dd'.repeat(20),
            signature: '0x' + 'ee'.repeat(65),
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed).toHaveProperty('proof');
        expect(parsed).toHaveProperty('publicInputs');
        expect(parsed).toHaveProperty('proofId');
        expect(parsed).toHaveProperty('nullifier');
      } finally {
        await transport.close();
      }
    });

    it('with missing circuitId returns isError: true', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        let gotError = false;
        try {
          const result = await client.callTool({
            name: 'generate_proof',
            arguments: {
              scope: 'test.com',
              address: '0x' + 'dd'.repeat(20),
              signature: '0x' + 'ee'.repeat(65),
            },
          });
          gotError = !!result.isError;
        } catch {
          gotError = true;
        }
        expect(gotError).toBe(true);
      } finally {
        await transport.close();
      }
    });

    it('with coinbase_country_attestation and countryList returns proof', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({
          name: 'generate_proof',
          arguments: {
            circuitId: 'coinbase_country_attestation',
            scope: 'test.com',
            address: '0x' + 'dd'.repeat(20),
            signature: '0x' + 'ee'.repeat(65),
            countryList: ['US', 'KR'],
            isIncluded: true,
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed).toHaveProperty('proof');
      } finally {
        await transport.close();
      }
    });
  });

  // ── 7. callTool — verify_proof ──────────────────────────────────────────

  describe('callTool — verify_proof', () => {
    it('with proof data (circuitId, proof, publicInputs) returns verification result', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.callTool({
          name: 'verify_proof',
          arguments: {
            circuitId: 'coinbase_attestation',
            proof: '0xaabb',
            publicInputs: ['0x' + 'cc'.repeat(32)],
            chainId: '84532',
          },
        });

        expect(result.isError).toBeFalsy();
        const parsed = parseToolResult(result);
        expect(parsed).toHaveProperty('chainId', '84532');
      } finally {
        await transport.close();
      }
    });

    it('with proofId from previous generate_proof returns verification result', async () => {
      // Step 1: Generate a proof to get a proofId
      const { client: genClient, transport: genTransport } = await createMcpClient(port);
      let proofId: string;
      try {
        const genResult = await genClient.callTool({
          name: 'generate_proof',
          arguments: {
            circuitId: 'coinbase_attestation',
            scope: 'test.com',
            address: '0x' + 'dd'.repeat(20),
            signature: '0x' + 'ee'.repeat(65),
          },
        });
        expect(genResult.isError).toBeFalsy();
        const genParsed = parseToolResult(genResult);
        proofId = genParsed.proofId;
        expect(proofId).toBeDefined();
      } finally {
        await genTransport.close();
      }

      // Step 2: Verify using proofId
      const { client: verifyClient, transport: verifyTransport } = await createMcpClient(port);
      try {
        const verifyResult = await verifyClient.callTool({
          name: 'verify_proof',
          arguments: { proofId },
        });

        expect(verifyResult.isError).toBeFalsy();
        const verifyParsed = parseToolResult(verifyResult);
        // Result should contain verification info
        expect(verifyParsed).toBeDefined();
      } finally {
        await verifyTransport.close();
      }
    });
  });

  // ── 8. Prompts ──────────────────────────────────────────────────────────

  describe('Prompts', () => {
    it('client.listPrompts() contains proof_flow', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listPrompts();
        expect(result.prompts).toBeDefined();
        expect(Array.isArray(result.prompts)).toBe(true);

        const promptNames = result.prompts.map((p) => p.name);
        expect(promptNames).toContain('proof_flow');
      } finally {
        await transport.close();
      }
    });

    it('client.getPrompt({ name: "proof_flow" }) returns messages with instructions', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.getPrompt({ name: 'proof_flow' });
        expect(result.messages).toBeDefined();
        expect(Array.isArray(result.messages)).toBe(true);
        expect(result.messages.length).toBeGreaterThan(0);

        const firstMessage = result.messages[0];
        expect(firstMessage.role).toBe('user');
        expect(firstMessage.content.type).toBe('text');
        expect((firstMessage.content as any).text).toContain('request_signing');
        expect((firstMessage.content as any).text).toContain('generate_proof');
      } finally {
        await transport.close();
      }
    });
  });

  // ── 9. Tool inputSchema Validation ──────────────────────────────────────

  describe('Tool inputSchema Validation', () => {
    it('request_signing requires circuitId and scope', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listTools();
        const tool = result.tools.find((t) => t.name === 'request_signing');
        expect(tool).toBeDefined();
        expect(tool!.inputSchema.required).toBeDefined();
        expect(tool!.inputSchema.required).toContain('circuitId');
        expect(tool!.inputSchema.required).toContain('scope');
      } finally {
        await transport.close();
      }
    });

    it('generate_proof requires circuitId and scope', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listTools();
        const tool = result.tools.find((t) => t.name === 'generate_proof');
        expect(tool).toBeDefined();
        expect(tool!.inputSchema.required).toBeDefined();
        expect(tool!.inputSchema.required).toContain('circuitId');
        expect(tool!.inputSchema.required).toContain('scope');
      } finally {
        await transport.close();
      }
    });

    it('verify_proof has no required fields (proofId or circuitId+proof+publicInputs)', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listTools();
        const tool = result.tools.find((t) => t.name === 'verify_proof');
        expect(tool).toBeDefined();
        // All fields are optional (can use proofId instead of the triplet)
        const required = tool!.inputSchema.required || [];
        expect(required).toHaveLength(0);
      } finally {
        await transport.close();
      }
    });

    it('get_supported_circuits has no required fields', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listTools();
        const tool = result.tools.find((t) => t.name === 'get_supported_circuits');
        expect(tool).toBeDefined();
        // get_supported_circuits takes no arguments
        const required = tool!.inputSchema.required || [];
        expect(required).toHaveLength(0);
      } finally {
        await transport.close();
      }
    });

    it('check_status requires requestId', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listTools();
        const tool = result.tools.find((t) => t.name === 'check_status');
        expect(tool).toBeDefined();
        expect(tool!.inputSchema.required).toContain('requestId');
      } finally {
        await transport.close();
      }
    });

    it('request_payment requires requestId', async () => {
      const { client, transport } = await createMcpClient(port);
      try {
        const result = await client.listTools();
        const tool = result.tools.find((t) => t.name === 'request_payment');
        expect(tool).toBeDefined();
        expect(tool!.inputSchema.required).toContain('requestId');
      } finally {
        await transport.close();
      }
    });
  });

  // ── 10. Full Session Flow ───────────────────────────────────────────────

  describe('Full Session Flow', () => {
    it('request_signing -> check_status -> generate_proof -> verify_proof', async () => {
      // Step 1: request_signing
      const { client: c1, transport: t1 } = await createMcpClient(port);
      let requestId: string;
      try {
        const signingResult = await c1.callTool({
          name: 'request_signing',
          arguments: { circuitId: 'coinbase_attestation', scope: 'test.com' },
        });
        expect(signingResult.isError).toBeFalsy();
        const signingData = parseToolResult(signingResult);
        requestId = signingData.requestId;
        expect(requestId).toBeDefined();
        expect(signingData.signingUrl).toBeDefined();
      } finally {
        await t1.close();
      }

      // Step 2: check_status with that requestId — phase should be "signing" or "ready"
      const { client: c2, transport: t2 } = await createMcpClient(port);
      try {
        const statusResult = await c2.callTool({
          name: 'check_status',
          arguments: { requestId },
        });
        expect(statusResult.isError).toBeFalsy();
        const statusData = parseToolResult(statusResult);
        expect(statusData.phase).toBeDefined();
        expect(['signing', 'ready', 'payment']).toContain(statusData.phase);
      } finally {
        await t2.close();
      }

      // Step 3: generate_proof with address + signature (bypass signing flow)
      const { client: c3, transport: t3 } = await createMcpClient(port);
      let proofData: any;
      try {
        const proofResult = await c3.callTool({
          name: 'generate_proof',
          arguments: {
            circuitId: 'coinbase_attestation',
            scope: 'test.com',
            address: '0x' + 'dd'.repeat(20),
            signature: '0x' + 'ee'.repeat(65),
          },
        });
        expect(proofResult.isError).toBeFalsy();
        proofData = parseToolResult(proofResult);
        expect(proofData.proof).toBeDefined();
        expect(proofData.publicInputs).toBeDefined();
        expect(proofData.proofId).toBeDefined();
      } finally {
        await t3.close();
      }

      // Step 4: verify_proof with the proof data
      const { client: c4, transport: t4 } = await createMcpClient(port);
      try {
        const verifyResult = await c4.callTool({
          name: 'verify_proof',
          arguments: {
            circuitId: 'coinbase_attestation',
            proof: proofData.proof,
            publicInputs: typeof proofData.publicInputs === 'string'
              ? [proofData.publicInputs]
              : proofData.publicInputs,
          },
        });
        expect(verifyResult.isError).toBeFalsy();
      } finally {
        await t4.close();
      }
    });
  });
});
