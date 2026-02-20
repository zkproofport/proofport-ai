import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock skillHandler before importing restRoutes
vi.mock('../src/skills/skillHandler.js', () => ({
  handleRequestSigning: vi.fn(),
  handleCheckStatus: vi.fn(),
  handleRequestPayment: vi.fn(),
  handleGenerateProof: vi.fn(),
  handleVerifyProof: vi.fn(),
  handleGetSupportedCircuits: vi.fn(),
}));

// Mock proofResultStore and verifier (used by /verify/:proofId endpoint)
vi.mock('../src/redis/proofResultStore.js', () => ({
  getProofResult: vi.fn(),
  storeProofResult: vi.fn(),
}));

vi.mock('../src/prover/verifier.js', () => ({
  verifyOnChain: vi.fn(),
}));

import { createRestRoutes } from '../src/api/restRoutes.js';
import {
  handleRequestSigning,
  handleCheckStatus,
  handleRequestPayment,
  handleGenerateProof,
  handleVerifyProof,
  handleGetSupportedCircuits,
} from '../src/skills/skillHandler.js';
import type { RestRoutesDeps } from '../src/api/restRoutes.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig() {
  return {
    signPageUrl: 'http://localhost:4002',
    a2aBaseUrl: 'http://localhost:4002',
    signingTtlSeconds: 300,
    paymentMode: 'disabled' as const,
    paymentProofPrice: '$0.10',
    easGraphqlEndpoint: 'https://base.easscan.org/graphql',
    baseRpcUrl: 'https://mainnet.base.org',
    bbPath: '/usr/local/bin/bb',
    nargoPath: '/usr/local/bin/nargo',
    circuitsDir: '/app/circuits',
    chainRpcUrl: 'https://sepolia.base.org',
    teeMode: 'disabled',
    // required by Config type but not used in the routes under test
    port: 4002,
    nodeEnv: 'test',
    proverUrl: '',
    circuitsRepoUrl: '',
    redisUrl: 'redis://localhost:6379',
    nullifierRegistryAddress: '0x0',
    proverPrivateKey: '0x0',
    websiteUrl: 'https://zkproofport.com',
    agentVersion: '1.0.0',
    paymentPayTo: '',
    paymentFacilitatorUrl: 'https://www.x402.org/facilitator',
    privyAppId: '',
    privyApiSecret: '',
    privyApiUrl: '',
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
    openaiApiKey: '',
    geminiApiKey: '',
    phoenixCollectorEndpoint: '',
  };
}

function makeDeps(overrides: Partial<RestRoutesDeps> = {}): RestRoutesDeps {
  return {
    taskStore: {
      createTask: vi.fn(),
      getTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      addArtifact: vi.fn(),
    } as any,
    taskEventEmitter: {} as any,
    redis: {} as any,
    config: makeConfig() as any,
    ...overrides,
  };
}

function makeApp(deps?: Partial<RestRoutesDeps>) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRestRoutes(makeDeps(deps)));
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('REST Routes — /api/v1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /circuits ──────────────────────────────────────────────────────────

  describe('GET /api/v1/circuits', () => {
    it('calls handleGetSupportedCircuits and returns JSON result', async () => {
      const mockResult = {
        circuits: [
          { id: 'coinbase_attestation', displayName: 'Coinbase KYC', description: '...', requiredInputs: [] },
        ],
        chainId: '84532',
      };
      vi.mocked(handleGetSupportedCircuits).mockReturnValue(mockResult);

      const res = await request(makeApp()).get('/api/v1/circuits');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockResult);
      expect(handleGetSupportedCircuits).toHaveBeenCalledWith({ chainId: undefined });
    });

    it('passes chainId query param to handleGetSupportedCircuits', async () => {
      vi.mocked(handleGetSupportedCircuits).mockReturnValue({ circuits: [], chainId: '8453' });

      const res = await request(makeApp()).get('/api/v1/circuits?chainId=8453');

      expect(res.status).toBe(200);
      expect(handleGetSupportedCircuits).toHaveBeenCalledWith({ chainId: '8453' });
    });
  });

  // ─── POST /signing ──────────────────────────────────────────────────────────

  describe('POST /api/v1/signing', () => {
    it('calls handleRequestSigning and returns 200 JSON', async () => {
      const mockResult = {
        requestId: 'req-111',
        signingUrl: 'http://localhost:4002/s/req-111',
        expiresAt: '2030-01-01T00:00:00.000Z',
        circuitId: 'coinbase_attestation',
        scope: 'myapp.com',
      };
      vi.mocked(handleRequestSigning).mockResolvedValue(mockResult);

      const res = await request(makeApp())
        .post('/api/v1/signing')
        .send({ circuitId: 'coinbase_attestation', scope: 'myapp.com' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockResult);
      expect(handleRequestSigning).toHaveBeenCalledOnce();
      expect(handleRequestSigning).toHaveBeenCalledWith(
        { circuitId: 'coinbase_attestation', scope: 'myapp.com', countryList: undefined, isIncluded: undefined },
        expect.any(Object),
      );
    });

    it('passes countryList and isIncluded for country circuit', async () => {
      vi.mocked(handleRequestSigning).mockResolvedValue({} as any);

      await request(makeApp())
        .post('/api/v1/signing')
        .send({
          circuitId: 'coinbase_country_attestation',
          scope: 'myapp.com',
          countryList: ['US', 'CA'],
          isIncluded: false,
        });

      expect(handleRequestSigning).toHaveBeenCalledWith(
        {
          circuitId: 'coinbase_country_attestation',
          scope: 'myapp.com',
          countryList: ['US', 'CA'],
          isIncluded: false,
        },
        expect.any(Object),
      );
    });

    it('returns 400 when handleRequestSigning throws', async () => {
      vi.mocked(handleRequestSigning).mockRejectedValue(
        new Error('circuitId is required. Use get_supported_circuits to see available circuits.'),
      );

      const res = await request(makeApp())
        .post('/api/v1/signing')
        .send({ scope: 'myapp.com' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('circuitId is required');
    });
  });

  // ─── GET /signing/:requestId/status ────────────────────────────────────────

  describe('GET /api/v1/signing/:requestId/status', () => {
    it('calls handleCheckStatus and returns 200 JSON', async () => {
      const mockResult = {
        requestId: 'req-abc',
        phase: 'signing' as const,
        signing: { status: 'pending' as const },
        payment: { status: 'not_required' as const },
        expiresAt: '2030-01-01T00:00:00.000Z',
      };
      vi.mocked(handleCheckStatus).mockResolvedValue(mockResult);

      const res = await request(makeApp()).get('/api/v1/signing/req-abc/status');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockResult);
      expect(handleCheckStatus).toHaveBeenCalledWith({ requestId: 'req-abc' }, expect.any(Object));
    });

    it('returns 404 when handleCheckStatus throws "not found" error', async () => {
      vi.mocked(handleCheckStatus).mockRejectedValue(
        new Error('Request not found or expired.'),
      );

      const res = await request(makeApp()).get('/api/v1/signing/unknown-id/status');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('returns 400 for non-not-found errors from handleCheckStatus', async () => {
      vi.mocked(handleCheckStatus).mockRejectedValue(new Error('requestId is required.'));

      const res = await request(makeApp()).get('/api/v1/signing/ /status');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('requestId is required');
    });
  });

  // ─── POST /signing/:requestId/payment ──────────────────────────────────────

  describe('POST /api/v1/signing/:requestId/payment', () => {
    it('calls handleRequestPayment and returns 200 JSON', async () => {
      const mockResult = {
        requestId: 'req-pay-1',
        paymentUrl: 'http://localhost:4002/pay/req-pay-1',
        amount: '$0.10',
        currency: 'USDC',
        network: 'Base Sepolia',
      };
      vi.mocked(handleRequestPayment).mockResolvedValue(mockResult);

      const res = await request(makeApp())
        .post('/api/v1/signing/req-pay-1/payment')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockResult);
      expect(handleRequestPayment).toHaveBeenCalledWith(
        { requestId: 'req-pay-1' },
        expect.any(Object),
      );
    });

    it('returns 400 when handleRequestPayment throws', async () => {
      vi.mocked(handleRequestPayment).mockRejectedValue(
        new Error('Payment is not required (payment mode is disabled).'),
      );

      const res = await request(makeApp())
        .post('/api/v1/signing/req-disabled/payment')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Payment is not required');
    });
  });

  // ─── POST /proofs ───────────────────────────────────────────────────────────

  describe('POST /api/v1/proofs', () => {
    it('calls handleGenerateProof with requestId and returns 200 JSON', async () => {
      const mockResult = {
        proof: '0xdeadbeef',
        publicInputs: '0xabcd',
        nullifier: '0x1234',
        signalHash: '0x5678',
        proofId: 'proof-id-1',
        verifyUrl: 'http://localhost:4002/v/proof-id-1',
      };
      vi.mocked(handleGenerateProof).mockResolvedValue(mockResult);

      const res = await request(makeApp())
        .post('/api/v1/proofs')
        .send({ requestId: 'req-done' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockResult);
      expect(handleGenerateProof).toHaveBeenCalledOnce();
      expect(handleGenerateProof).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'req-done' }),
        expect.any(Object),
      );
    });

    it('calls handleGenerateProof with direct-flow params', async () => {
      vi.mocked(handleGenerateProof).mockResolvedValue({} as any);

      await request(makeApp())
        .post('/api/v1/proofs')
        .send({
          circuitId: 'coinbase_attestation',
          scope: 'myapp.com',
          address: '0xUserAddress',
          signature: '0xSig',
        });

      expect(handleGenerateProof).toHaveBeenCalledWith(
        expect.objectContaining({
          circuitId: 'coinbase_attestation',
          scope: 'myapp.com',
          address: '0xUserAddress',
          signature: '0xSig',
        }),
        expect.any(Object),
      );
    });

    it('records payment via paymentFacilitator when x402Payment is on request', async () => {
      const mockResult = {
        proof: '0x',
        publicInputs: '0x',
        nullifier: '0x',
        signalHash: '0x',
        proofId: 'proof-paid',
        verifyUrl: 'http://localhost:4002/v/proof-paid',
      };
      vi.mocked(handleGenerateProof).mockResolvedValue(mockResult);

      const mockRecordPayment = vi.fn().mockResolvedValue(undefined);
      const appWithFacilitator = express();
      appWithFacilitator.use(express.json());

      // Inject x402Payment onto request to simulate middleware
      appWithFacilitator.use((req: any, _res, next) => {
        req.x402Payment = {
          payerAddress: '0xPayer',
          amount: '100000',
          network: 'base-sepolia',
        };
        next();
      });

      appWithFacilitator.use(
        '/api/v1',
        createRestRoutes(
          makeDeps({
            paymentFacilitator: { recordPayment: mockRecordPayment } as any,
          }),
        ),
      );

      const res = await request(appWithFacilitator)
        .post('/api/v1/proofs')
        .send({ requestId: 'req-done' });

      expect(res.status).toBe(200);
      expect(mockRecordPayment).toHaveBeenCalledOnce();
      expect(mockRecordPayment).toHaveBeenCalledWith({
        taskId: 'proof-paid',
        payerAddress: '0xPayer',
        amount: '100000',
        network: 'base-sepolia',
      });
    });

    it('returns 400 when handleGenerateProof throws', async () => {
      vi.mocked(handleGenerateProof).mockRejectedValue(
        new Error('Signing not yet completed.'),
      );

      const res = await request(makeApp())
        .post('/api/v1/proofs')
        .send({ requestId: 'req-not-signed' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Signing not yet completed');
    });
  });

  // ─── POST /proofs/verify ────────────────────────────────────────────────────

  describe('POST /api/v1/proofs/verify', () => {
    it('calls handleVerifyProof and returns 200 JSON', async () => {
      const mockResult = {
        valid: true,
        circuitId: 'coinbase_attestation',
        verifierAddress: '0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c',
        chainId: '84532',
      };
      vi.mocked(handleVerifyProof).mockResolvedValue(mockResult);

      const res = await request(makeApp())
        .post('/api/v1/proofs/verify')
        .send({
          circuitId: 'coinbase_attestation',
          proof: '0xdeadbeef',
          publicInputs: ['0x1111', '0x2222'],
          chainId: '84532',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockResult);
      expect(handleVerifyProof).toHaveBeenCalledOnce();
      expect(handleVerifyProof).toHaveBeenCalledWith(
        {
          circuitId: 'coinbase_attestation',
          proof: '0xdeadbeef',
          publicInputs: ['0x1111', '0x2222'],
          chainId: '84532',
        },
        expect.any(Object),
      );
    });

    it('uses empty defaults when circuitId, proof, publicInputs are missing', async () => {
      vi.mocked(handleVerifyProof).mockRejectedValue(new Error('circuitId is required.'));

      const res = await request(makeApp())
        .post('/api/v1/proofs/verify')
        .send({});

      expect(res.status).toBe(400);
      // The handler was called with empty string defaults
      expect(handleVerifyProof).toHaveBeenCalledWith(
        { circuitId: '', proof: '', publicInputs: [], chainId: undefined },
        expect.any(Object),
      );
    });

    it('returns 400 when handleVerifyProof throws', async () => {
      vi.mocked(handleVerifyProof).mockRejectedValue(
        new Error('No verifier deployed for circuit "bad_circuit" on chain "84532".'),
      );

      const res = await request(makeApp())
        .post('/api/v1/proofs/verify')
        .send({ circuitId: 'bad_circuit', proof: '0x', publicInputs: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('No verifier deployed');
    });
  });
});
