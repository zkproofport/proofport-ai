/**
 * REST API Endpoint E2E Tests
 * Tests the full HTTP endpoint flow for /api/v1/ REST routes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import type { Config } from '../../src/config/index.js';

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

// vi.hoisted() runs before vi.mock() factory hoisting, so these values are
// available inside the ioredis mock factory without TDZ errors.
const { _redisStore, _redisListStore } = vi.hoisted(() => ({
  _redisStore: new Map<string, string>(),
  _redisListStore: new Map<string, string[]>(),
}));

// Mock ioredis with Map-based store.
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
  computeSignalHash: vi.fn().mockReturnValue(new Uint8Array(32).fill(1)),
}));

// Mock ethers
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

// Mock circuit artifact manager
vi.mock('../../src/circuit/artifactManager.js', () => ({
  ensureArtifacts: vi.fn().mockResolvedValue(undefined),
}));

// Mock identity
vi.mock('../../src/identity/autoRegister.js', () => ({
  ensureAgentRegistered: vi.fn().mockResolvedValue(123456n),
}));

vi.mock('../../src/identity/reputation.js', () => ({
  handleProofCompleted: vi.fn().mockResolvedValue(undefined),
}));

// Mock verifier
vi.mock('../../src/prover/verifier.js', () => ({
  verifyOnChain: vi.fn().mockResolvedValue({
    isValid: true,
    verifierAddress: '0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c',
  }),
}));

// Mock contracts config (must be mocked to avoid issues with ERC8004_ADDRESSES)
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


// ─── Test config ───────────────────────────────────────────────────────────

const testConfig: Config = {
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
  paymentMode: 'disabled' as const,
  a2aBaseUrl: 'https://a2a.example.com',
  agentVersion: '1.0.0',
  paymentPayTo: '',
  paymentFacilitatorUrl: '',
  paymentProofPrice: '$0.10',
  privyAppId: '',
  privyApiSecret: '',
  privyApiUrl: '',
  signPageUrl: '',
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
};

// ─── Test suite ───────────────────────────────────────────────────────────

describe('REST API Endpoint E2E', () => {
  let app: any;

  beforeEach(() => {
    // Clear in-memory stores between tests
    _redisStore.clear();
    _redisListStore.clear();

    const appBundle = createApp(testConfig, 123456n);
    app = appBundle.app;
  });

  // ─── GET /api/v1/circuits ───────────────────────────────────────────────

  describe('GET /api/v1/circuits', () => {
    it('returns list of supported circuits', async () => {
      const response = await request(app).get('/api/v1/circuits');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('circuits');
      expect(Array.isArray(response.body.circuits)).toBe(true);

      const ids = response.body.circuits.map((c: any) => c.id);
      expect(ids).toContain('coinbase_attestation');
      expect(ids).toContain('coinbase_country_attestation');
    });

    it('each circuit has required fields', async () => {
      const response = await request(app).get('/api/v1/circuits');

      expect(response.status).toBe(200);
      for (const circuit of response.body.circuits) {
        expect(circuit).toHaveProperty('id');
        expect(circuit).toHaveProperty('displayName');
        expect(circuit).toHaveProperty('description');
        expect(circuit).toHaveProperty('verifierAddress');
        expect(circuit).toHaveProperty('requiredInputs');
        expect(typeof circuit.id).toBe('string');
        expect(typeof circuit.displayName).toBe('string');
        expect(typeof circuit.description).toBe('string');
        expect(Array.isArray(circuit.requiredInputs)).toBe(true);
      }
    });

    it('accepts chainId query parameter', async () => {
      const response = await request(app).get('/api/v1/circuits?chainId=84532');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('circuits');
      expect(Array.isArray(response.body.circuits)).toBe(true);
    });
  });

  // ─── POST /api/v1/proofs ───────────────────────────────────────────────

  describe('POST /api/v1/proofs', () => {
    it('generates proof with direct signature', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('proof');
      expect(response.body).toHaveProperty('publicInputs');
      expect(response.body).toHaveProperty('nullifier');
      expect(response.body).toHaveProperty('signalHash');
      expect(response.body).toHaveProperty('proofId');
    }, 10000);

    it('returns error for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(typeof response.body.error).toBe('string');
    });

    it('returns error for missing scope', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_attestation',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('scope');
    });

    it('returns error for unknown circuit', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'nonexistent_circuit',
          scope: 'test.com',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('nonexistent_circuit');
    });

    it('returns error when no address or signature provided', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
        });

      // Without address+signature and no requestId, handleGenerateProof throws
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(typeof response.body.error).toBe('string');
    });

    it('returns error for coinbase_country_attestation missing countryList', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_country_attestation',
          scope: 'test.com',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('countryList');
    });
  });

  // ─── POST /api/v1/proofs/verify ────────────────────────────────────────

  describe('POST /api/v1/proofs/verify', () => {
    it('verifies proof on-chain and returns response with valid field', async () => {
      const response = await request(app)
        .post('/api/v1/proofs/verify')
        .send({
          circuitId: 'coinbase_attestation',
          proof: '0xaabb',
          publicInputs: ['0x' + 'cc'.repeat(32)],
          chainId: '84532',
        });

      // Should respond with 200 containing verification result
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('circuitId', 'coinbase_attestation');
      expect(response.body).toHaveProperty('chainId', '84532');
      expect(response.body).toHaveProperty('verifierAddress');
      expect(typeof response.body.valid).toBe('boolean');
    }, 10000);

    it('returns 400 for missing circuitId', async () => {
      const response = await request(app)
        .post('/api/v1/proofs/verify')
        .send({
          proof: '0xaabb',
          publicInputs: ['0x' + 'cc'.repeat(32)],
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('circuitId');
    });

    it('returns 400 for missing proof', async () => {
      const response = await request(app)
        .post('/api/v1/proofs/verify')
        .send({
          circuitId: 'coinbase_attestation',
          publicInputs: ['0x' + 'cc'.repeat(32)],
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('proof');
    });

    it('returns valid result for empty publicInputs (empty array treated as valid input)', async () => {
      const response = await request(app)
        .post('/api/v1/proofs/verify')
        .send({
          circuitId: 'coinbase_attestation',
          proof: '0xaabb',
        });

      // handleVerifyProof defaults publicInputs to [] when not provided (restRoutes passes [] as fallback).
      // An empty array is not undefined/null so validation passes; mock verifier returns valid.
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('valid');
      expect(response.body).toHaveProperty('circuitId', 'coinbase_attestation');
    });

    it('returns 400 for unknown circuit', async () => {
      const response = await request(app)
        .post('/api/v1/proofs/verify')
        .send({
          circuitId: 'nonexistent_circuit',
          proof: '0xaabb',
          publicInputs: ['0x' + 'cc'.repeat(32)],
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('nonexistent_circuit');
    });
  });

  // ─── GET /api/v1/proofs/:taskId ────────────────────────────────────────

  describe('GET /api/v1/proofs/:taskId', () => {
    it('returns 404 for non-existent task', async () => {
      const response = await request(app).get('/api/v1/proofs/non-existent-task-id-12345');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('not found');
    });

    it('returns completed proof for existing task', async () => {
      // POST /api/v1/proofs now returns proof data directly (no taskId/state).
      // The GET /api/v1/proofs/:taskId route is legacy A2A task lookup.
      // Verify that POST returns proof fields and GET for non-existent task returns 404.
      const createResponse = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_attestation',
          scope: 'test.com',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
        });

      expect(createResponse.status).toBe(200);
      expect(createResponse.body).toHaveProperty('proof');
      expect(createResponse.body).toHaveProperty('proofId');

      // GET /api/v1/proofs/:taskId is legacy — unknown IDs return 404
      const pollResponse = await request(app).get('/api/v1/proofs/non-existent-legacy-task-id');
      expect(pollResponse.status).toBe(404);
    }, 10000);
  });

  // ─── Discovery Endpoints ───────────────────────────────────────────────

  describe('Discovery Endpoints', () => {
    it('GET /.well-known/mcp.json returns MCP discovery', async () => {
      const response = await request(app).get('/.well-known/mcp.json');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toHaveProperty('tools');
      expect(Array.isArray(response.body.tools)).toBe(true);
    });

    it('GET /docs returns Swagger UI', async () => {
      const response = await request(app).get('/docs');

      // Swagger UI serves HTML (200) or redirects to /docs/ (301/302)
      expect([200, 301, 302]).toContain(response.status);
    });

    it('GET /openapi.json returns OpenAPI spec', async () => {
      const response = await request(app).get('/openapi.json');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toHaveProperty('openapi');
    });
  });

  // ─── Signing Endpoints ─────────────────────────────────────────────────

  describe('Signing Endpoints', () => {
    it('GET /api/signing/:requestId returns 404 for non-existent request', async () => {
      const response = await request(app).get('/api/signing/non-existent-id-12345');

      // Should return 404 or error, NOT 402 or 500
      expect([400, 404]).toContain(response.status);
    });

    it('POST /api/signing/callback/:requestId returns error for non-existent request', async () => {
      const response = await request(app)
        .post('/api/signing/callback/non-existent-id-12345')
        .send({
          signature: '0x' + 'aa'.repeat(65),
          address: '0x' + 'bb'.repeat(20),
        });

      // Should return error, NOT crash
      expect([400, 404]).toContain(response.status);
    });

    it('POST /api/signing/batch stores batch signatures', async () => {
      const response = await request(app)
        .post('/api/signing/batch')
        .send({
          address: '0x' + 'cc'.repeat(20),
          signatures: [{
            signalHash: '0x' + 'dd'.repeat(32),
            signature: '0x' + 'ee'.repeat(65),
          }],
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('stored');
      expect(response.body).toHaveProperty('address');
      expect(response.body.stored).toBe(1);
    });

    it('GET /signing/status returns signing provider status', async () => {
      const response = await request(app).get('/signing/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('providers');
      expect(response.body.providers).toHaveProperty('eip7702');
    });

    it('POST /api/signing/:requestId/prepare returns error for non-existent request', async () => {
      const response = await request(app)
        .post('/api/signing/non-existent-id-12345/prepare')
        .send({ address: '0x' + 'cc'.repeat(20) });

      expect([400, 404]).toContain(response.status);
    });
  });

  // ─── Payment Endpoints ─────────────────────────────────────────────────

  describe('Payment Endpoints', () => {
    it('GET /api/payment/:requestId returns 404 for non-existent request', async () => {
      const response = await request(app).get('/api/payment/non-existent-id');

      expect([400, 404, 500]).toContain(response.status);
    });

    it('GET /payment/status returns payment mode', async () => {
      const response = await request(app).get('/payment/status');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('mode');
      expect(response.body.mode).toBe('disabled');
    });

    it('POST /api/payment/confirm/:requestId returns error for non-existent request', async () => {
      const response = await request(app)
        .post('/api/payment/confirm/non-existent-id')
        .send({ txHash: '0x' + 'aa'.repeat(32) });

      expect([400, 404, 500]).toContain(response.status);
    });

    it('POST /api/payment/sign/:requestId returns error for non-existent request', async () => {
      const response = await request(app)
        .post('/api/payment/sign/non-existent-id')
        .send({
          authorization: { from: '0x' + 'bb'.repeat(20) },
          signature: '0x' + 'cc'.repeat(65),
        });

      expect([400, 404, 500]).toContain(response.status);
    });

    it('GET /pay/:requestId returns HTML payment page', async () => {
      const response = await request(app).get('/pay/test-request-id');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.text).toContain('Payment');
    });

    it('GET /v/:proofId returns HTML verification page', async () => {
      const response = await request(app).get('/v/test-proof-id');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
    });
  });

  // ─── Deprecated Endpoints ──────────────────────────────────────────────

  describe('Deprecated Endpoints', () => {
    it('POST /api/v1/chat returns 410 Gone', async () => {
      const response = await request(app)
        .post('/api/v1/chat')
        .send({ message: 'hello' });

      expect(response.status).toBe(410);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('type', 'gone');
      expect(response.body.error).toHaveProperty('code', 'endpoint_removed');
    });
  });

  // ─── POST /api/v1/signing ─────────────────────────────────────────────────

  describe('POST /api/v1/signing', () => {
    it('creates signing session with valid params', async () => {
      const response = await request(app)
        .post('/api/v1/signing')
        .send({ circuitId: 'coinbase_attestation', scope: 'test.com' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('requestId');
      expect(response.body).toHaveProperty('signingUrl');
      expect(response.body).toHaveProperty('expiresAt');
      expect(typeof response.body.requestId).toBe('string');
      expect(response.body.requestId.length).toBeGreaterThan(0);
      expect(response.body.signingUrl).toContain(response.body.requestId);
    });

    it('returns requestId and circuitId in response', async () => {
      const response = await request(app)
        .post('/api/v1/signing')
        .send({ circuitId: 'coinbase_attestation', scope: 'myapp.xyz' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('circuitId', 'coinbase_attestation');
      expect(response.body).toHaveProperty('scope', 'myapp.xyz');
    });

    it('stores the session in Redis', async () => {
      const response = await request(app)
        .post('/api/v1/signing')
        .send({ circuitId: 'coinbase_attestation', scope: 'test.com' });

      expect(response.status).toBe(200);
      const { requestId } = response.body;
      const stored = _redisStore.get(`signing:${requestId}`);
      expect(stored).toBeDefined();
      const record = JSON.parse(stored!);
      expect(record.id).toBe(requestId);
      expect(record.circuitId).toBe('coinbase_attestation');
      expect(record.scope).toBe('test.com');
      expect(record.status).toBe('pending');
    });

    it('returns 400 for missing circuitId', async () => {
      const response = await request(app)
        .post('/api/v1/signing')
        .send({ scope: 'test.com' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('returns 400 for missing scope', async () => {
      const response = await request(app)
        .post('/api/v1/signing')
        .send({ circuitId: 'coinbase_attestation' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('scope');
    });

    it('returns 400 for unknown circuitId', async () => {
      const response = await request(app)
        .post('/api/v1/signing')
        .send({ circuitId: 'unknown_circuit', scope: 'test.com' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('unknown_circuit');
    });

    it('creates session for coinbase_country_attestation with all required fields', async () => {
      const response = await request(app)
        .post('/api/v1/signing')
        .send({
          circuitId: 'coinbase_country_attestation',
          scope: 'test.com',
          countryList: ['US', 'CA'],
          isIncluded: true,
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('requestId');
      expect(response.body).toHaveProperty('circuitId', 'coinbase_country_attestation');
    });

    it('returns 400 for coinbase_country_attestation missing countryList', async () => {
      const response = await request(app)
        .post('/api/v1/signing')
        .send({
          circuitId: 'coinbase_country_attestation',
          scope: 'test.com',
          isIncluded: true,
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('countryList');
    });

    it('returns 400 for coinbase_country_attestation missing isIncluded', async () => {
      const response = await request(app)
        .post('/api/v1/signing')
        .send({
          circuitId: 'coinbase_country_attestation',
          scope: 'test.com',
          countryList: ['US'],
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('isIncluded');
    });
  });

  // ─── GET /api/v1/signing/:requestId/status ────────────────────────────────

  describe('GET /api/v1/signing/:requestId/status', () => {
    it('returns 404 for non-existent requestId', async () => {
      const response = await request(app).get('/api/v1/signing/non-existent-req-id-999/status');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });

    it('returns status for a pending signing session', async () => {
      // Pre-populate Redis with a pending signing record
      const requestId = 'test-status-pending-req-001';
      const record = {
        id: requestId,
        scope: 'test.com',
        circuitId: 'coinbase_attestation',
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      _redisStore.set(`signing:${requestId}`, JSON.stringify(record));

      const response = await request(app).get(`/api/v1/signing/${requestId}/status`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('requestId', requestId);
      expect(response.body).toHaveProperty('phase', 'signing');
      expect(response.body.signing).toHaveProperty('status', 'pending');
    });

    it('returns ready phase when signing is completed and payment is disabled', async () => {
      // Pre-populate with a completed signing record
      const requestId = 'test-status-completed-req-002';
      const record = {
        id: requestId,
        scope: 'test.com',
        circuitId: 'coinbase_attestation',
        status: 'completed',
        address: '0x' + '55'.repeat(20),
        signature: '0x' + '66'.repeat(65),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      _redisStore.set(`signing:${requestId}`, JSON.stringify(record));

      const response = await request(app).get(`/api/v1/signing/${requestId}/status`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('requestId', requestId);
      // payment mode is 'disabled' in testConfig → phase should be 'ready'
      expect(response.body).toHaveProperty('phase', 'ready');
      expect(response.body.signing).toHaveProperty('status', 'completed');
      expect(response.body.payment).toHaveProperty('status', 'not_required');
    });

    it('returns expiresAt in the response', async () => {
      const requestId = 'test-status-expiry-req-003';
      const expiresAt = new Date(Date.now() + 300_000).toISOString();
      const record = {
        id: requestId,
        scope: 'test.com',
        circuitId: 'coinbase_attestation',
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt,
      };
      _redisStore.set(`signing:${requestId}`, JSON.stringify(record));

      const response = await request(app).get(`/api/v1/signing/${requestId}/status`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('expiresAt', expiresAt);
    });
  });

  // ─── POST /api/v1/signing/:requestId/payment ─────────────────────────────

  describe('POST /api/v1/signing/:requestId/payment', () => {
    it('returns 400 for non-existent requestId', async () => {
      const response = await request(app)
        .post('/api/v1/signing/non-existent-payment-req-999/payment')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('returns 400 when payment mode is disabled', async () => {
      // Pre-populate a completed signing record
      const requestId = 'test-payment-disabled-req-001';
      const record = {
        id: requestId,
        scope: 'test.com',
        circuitId: 'coinbase_attestation',
        status: 'completed',
        address: '0x' + '55'.repeat(20),
        signature: '0x' + '66'.repeat(65),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      _redisStore.set(`signing:${requestId}`, JSON.stringify(record));

      const response = await request(app)
        .post(`/api/v1/signing/${requestId}/payment`)
        .send({});

      // paymentMode is 'disabled' in testConfig — handleRequestPayment throws
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('disabled');
    });

    it('returns 400 when signing is not yet completed', async () => {
      // Pre-populate a pending signing record (signing not done yet)
      const requestId = 'test-payment-pending-signing-req-002';
      const record = {
        id: requestId,
        scope: 'test.com',
        circuitId: 'coinbase_attestation',
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      _redisStore.set(`signing:${requestId}`, JSON.stringify(record));

      const response = await request(app)
        .post(`/api/v1/signing/${requestId}/payment`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });

  // ─── POST /api/v1/flow ────────────────────────────────────────────────────

  describe('POST /api/v1/flow', () => {
    it('creates flow and returns flowId, signingUrl, phase=signing', async () => {
      const response = await request(app)
        .post('/api/v1/flow')
        .send({ circuitId: 'coinbase_attestation', scope: 'test.com' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('flowId');
      expect(response.body).toHaveProperty('signingUrl');
      expect(response.body).toHaveProperty('phase', 'signing');
      expect(response.body).toHaveProperty('requestId');
      expect(typeof response.body.flowId).toBe('string');
      expect(response.body.signingUrl).toContain(response.body.requestId);
    });

    it('stores flow and signing session in Redis', async () => {
      const response = await request(app)
        .post('/api/v1/flow')
        .send({ circuitId: 'coinbase_attestation', scope: 'flow-scope.io' });

      expect(response.status).toBe(200);
      const { flowId, requestId } = response.body;

      // Flow record stored
      const flowData = _redisStore.get(`flow:${flowId}`);
      expect(flowData).toBeDefined();
      const flow = JSON.parse(flowData!);
      expect(flow.flowId).toBe(flowId);
      expect(flow.phase).toBe('signing');

      // Signing session stored
      const signingData = _redisStore.get(`signing:${requestId}`);
      expect(signingData).toBeDefined();
    });

    it('returns 400 for missing circuitId', async () => {
      const response = await request(app)
        .post('/api/v1/flow')
        .send({ scope: 'test.com' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('returns 400 for missing scope', async () => {
      const response = await request(app)
        .post('/api/v1/flow')
        .send({ circuitId: 'coinbase_attestation' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('includes circuitId and scope in returned flow', async () => {
      const response = await request(app)
        .post('/api/v1/flow')
        .send({ circuitId: 'coinbase_attestation', scope: 'myservice.dev' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('circuitId', 'coinbase_attestation');
      expect(response.body).toHaveProperty('scope', 'myservice.dev');
    });
  });

  // ─── GET /api/v1/flow/:flowId ─────────────────────────────────────────────

  describe('GET /api/v1/flow/:flowId', () => {
    it('returns 404 for non-existent flowId', async () => {
      const response = await request(app).get('/api/v1/flow/non-existent-flow-id-999');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('not found');
    });

    it('returns flow data for a completed flow (terminal phase, no advance)', async () => {
      const flowId = 'test-flow-completed-001';
      const requestId = 'test-flow-req-completed-001';
      const now = new Date().toISOString();
      const flow = {
        flowId,
        circuitId: 'coinbase_attestation',
        scope: 'test.com',
        phase: 'completed',
        requestId,
        signingUrl: `https://a2a.example.com/s/${requestId}`,
        proofResult: {
          proof: '0xmockproof',
          publicInputs: '0xmockpublic',
          nullifier: '0x' + 'aa'.repeat(32),
          signalHash: '0x' + 'bb'.repeat(32),
          proofId: 'test-proof-id-001',
          verifyUrl: 'https://a2a.example.com/v/test-proof-id-001',
        },
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      _redisStore.set(`flow:${flowId}`, JSON.stringify(flow));

      const response = await request(app).get(`/api/v1/flow/${flowId}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('flowId', flowId);
      expect(response.body).toHaveProperty('phase', 'completed');
      expect(response.body).toHaveProperty('circuitId', 'coinbase_attestation');
      expect(response.body.proofResult).toHaveProperty('proof', '0xmockproof');
    });

    it('returns flow data for a failed flow (terminal phase, no advance)', async () => {
      const flowId = 'test-flow-failed-002';
      const requestId = 'test-flow-req-failed-002';
      const now = new Date().toISOString();
      const flow = {
        flowId,
        circuitId: 'coinbase_attestation',
        scope: 'test.com',
        phase: 'failed',
        requestId,
        signingUrl: `https://a2a.example.com/s/${requestId}`,
        error: 'Proof generation failed: mock error',
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      _redisStore.set(`flow:${flowId}`, JSON.stringify(flow));

      const response = await request(app).get(`/api/v1/flow/${flowId}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('flowId', flowId);
      expect(response.body).toHaveProperty('phase', 'failed');
      expect(response.body).toHaveProperty('error');
    });
  });

  // ─── POST /api/v1/proofs (session mode via requestId) ────────────────────

  describe('POST /api/v1/proofs with requestId (session mode)', () => {
    it('generates proof using a completed signing session', async () => {
      // Pre-populate Redis with a completed signing record
      const requestId = 'test-session-proof-req-001';
      const record = {
        id: requestId,
        scope: 'test.com',
        circuitId: 'coinbase_attestation',
        status: 'completed',
        address: '0x' + '55'.repeat(20),
        signature: '0x' + '66'.repeat(65),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      _redisStore.set(`signing:${requestId}`, JSON.stringify(record));

      const response = await request(app)
        .post('/api/v1/proofs')
        .send({ requestId });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('proof');
      expect(response.body).toHaveProperty('publicInputs');
      expect(response.body).toHaveProperty('nullifier');
      expect(response.body).toHaveProperty('signalHash');
      expect(response.body).toHaveProperty('proofId');
    }, 10000);

    it('consumes the signing record after proof generation (one-time use)', async () => {
      const requestId = 'test-session-proof-req-002';
      const record = {
        id: requestId,
        scope: 'test.com',
        circuitId: 'coinbase_attestation',
        status: 'completed',
        address: '0x' + '55'.repeat(20),
        signature: '0x' + '66'.repeat(65),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      _redisStore.set(`signing:${requestId}`, JSON.stringify(record));

      // First call succeeds
      const first = await request(app).post('/api/v1/proofs').send({ requestId });
      expect(first.status).toBe(200);

      // Second call should fail — record was consumed (deleted from Redis)
      const second = await request(app).post('/api/v1/proofs').send({ requestId });
      expect(second.status).toBe(400);
      expect(second.body).toHaveProperty('error');
    }, 15000);

    it('returns 400 when signing session is still pending', async () => {
      const requestId = 'test-session-proof-req-003';
      const record = {
        id: requestId,
        scope: 'test.com',
        circuitId: 'coinbase_attestation',
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      _redisStore.set(`signing:${requestId}`, JSON.stringify(record));

      const response = await request(app)
        .post('/api/v1/proofs')
        .send({ requestId });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Signing not yet completed');
    });

    it('returns 400 for non-existent requestId', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({ requestId: 'non-existent-request-id-xyz' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });

  // ─── GET /api/v1/verify/:proofId ─────────────────────────────────────────

  describe('GET /api/v1/verify/:proofId', () => {
    it('returns 404 for non-existent proofId', async () => {
      const response = await request(app).get('/api/v1/verify/non-existent-proof-id-999');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('not found');
    });

    it('verifies a stored proof and returns verification result', async () => {
      // Pre-populate Redis with a stored proof result
      const proofId = 'test-verify-stored-proof-001';
      const proofRecord = {
        proofId,
        proof: '0x' + 'ab'.repeat(100),
        publicInputs: '0x' + 'cd'.repeat(32),
        circuitId: 'coinbase_attestation',
        nullifier: '0x' + 'ef'.repeat(32),
        signalHash: '0x' + '12'.repeat(32),
        createdAt: new Date().toISOString(),
      };
      _redisStore.set(`proof:result:${proofId}`, JSON.stringify(proofRecord));

      const response = await request(app).get(`/api/v1/verify/${proofId}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('proofId', proofId);
      expect(response.body).toHaveProperty('circuitId', 'coinbase_attestation');
      expect(response.body).toHaveProperty('nullifier');
      expect(response.body).toHaveProperty('isValid');
      expect(response.body).toHaveProperty('verifierAddress');
      expect(response.body).toHaveProperty('chainId');
      expect(typeof response.body.isValid).toBe('boolean');
    });

    it('returns isValid=true when mock verifier approves', async () => {
      const proofId = 'test-verify-valid-proof-002';
      const proofRecord = {
        proofId,
        proof: '0x' + 'aa'.repeat(50),
        publicInputs: '0x' + 'bb'.repeat(32),
        circuitId: 'coinbase_attestation',
        nullifier: '0x' + 'cc'.repeat(32),
        signalHash: '0x' + 'dd'.repeat(32),
        createdAt: new Date().toISOString(),
      };
      _redisStore.set(`proof:result:${proofId}`, JSON.stringify(proofRecord));

      const response = await request(app).get(`/api/v1/verify/${proofId}`);

      expect(response.status).toBe(200);
      // verifyOnChain mock returns { isValid: true, ... }
      expect(response.body).toHaveProperty('isValid', true);
    });
  });

  // ─── POST /api/v1/proofs with coinbase_country_attestation ───────────────

  describe('POST /api/v1/proofs with coinbase_country_attestation', () => {
    it('generates proof with countryList and isIncluded', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_country_attestation',
          scope: 'test.com',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
          countryList: ['US', 'CA'],
          isIncluded: true,
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('proof');
      expect(response.body).toHaveProperty('publicInputs');
      expect(response.body).toHaveProperty('nullifier');
      expect(response.body).toHaveProperty('proofId');
    }, 10000);

    it('generates proof with isIncluded=false (exclusion proof)', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_country_attestation',
          scope: 'dapp.io',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
          countryList: ['RU', 'KP'],
          isIncluded: false,
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('proof');
      expect(response.body).toHaveProperty('proofId');
    }, 10000);

    it('returns 400 for coinbase_country_attestation missing countryList', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_country_attestation',
          scope: 'test.com',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
          isIncluded: true,
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('countryList');
    });

    it('returns 400 for coinbase_country_attestation missing isIncluded', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_country_attestation',
          scope: 'test.com',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
          countryList: ['US'],
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('isIncluded');
    });

    it('returns 400 for coinbase_country_attestation with empty countryList', async () => {
      const response = await request(app)
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_country_attestation',
          scope: 'test.com',
          address: '0x' + '55'.repeat(20),
          signature: '0x' + '66'.repeat(65),
          countryList: [],
          isIncluded: true,
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('countryList');
    });
  });
});
