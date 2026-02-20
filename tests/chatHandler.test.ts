import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock skillHandler before importing chatHandler
vi.mock('../src/skills/skillHandler.js', () => ({
  handleRequestSigning: vi.fn(),
  handleCheckStatus: vi.fn(),
  handleRequestPayment: vi.fn(),
  handleGenerateProof: vi.fn(),
  handleVerifyProof: vi.fn(),
  handleGetSupportedCircuits: vi.fn(),
}));

import { executeSkill } from '../src/chat/chatHandler.js';
import {
  handleRequestSigning,
  handleCheckStatus,
  handleRequestPayment,
  handleGenerateProof,
  handleVerifyProof,
  handleGetSupportedCircuits,
} from '../src/skills/skillHandler.js';
import type { ChatHandlerDeps } from '../src/chat/chatHandler.js';

// Minimal deps object — skillHandler is mocked so actual values don't matter
function makeDeps(overrides: Partial<ChatHandlerDeps> = {}): ChatHandlerDeps {
  return {
    redis: {} as any,
    taskStore: {} as any,
    taskEventEmitter: {} as any,
    a2aBaseUrl: 'http://localhost:4002',
    llmProvider: {} as any,
    signPageUrl: 'http://localhost:4002',
    signingTtlSeconds: 300,
    paymentMode: 'disabled',
    paymentProofPrice: '$0.10',
    easGraphqlEndpoint: 'https://base.easscan.org/graphql',
    rpcUrls: ['https://mainnet.base.org'],
    bbPath: '/usr/local/bin/bb',
    nargoPath: '/usr/local/bin/nargo',
    circuitsDir: '/app/circuits',
    chainRpcUrl: 'https://sepolia.base.org',
    teeMode: 'disabled',
    ...overrides,
  };
}

describe('executeSkill — chatHandler adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── request_signing ────────────────────────────────────────────────────────

  it('routes request_signing to handleRequestSigning with correct params', async () => {
    const mockResult = {
      requestId: 'req-123',
      signingUrl: 'http://localhost:4002/s/req-123',
      expiresAt: '2030-01-01T00:00:00.000Z',
      circuitId: 'coinbase_attestation',
      scope: 'myapp.com',
    };
    vi.mocked(handleRequestSigning).mockResolvedValue(mockResult);

    const result = await executeSkill(
      'request_signing',
      { circuitId: 'coinbase_attestation', scope: 'myapp.com' },
      makeDeps(),
    );

    expect(handleRequestSigning).toHaveBeenCalledOnce();
    expect(handleRequestSigning).toHaveBeenCalledWith(
      { circuitId: 'coinbase_attestation', scope: 'myapp.com', countryList: undefined, isIncluded: undefined },
      expect.objectContaining({ signPageUrl: 'http://localhost:4002', paymentMode: 'disabled' }),
    );
    expect(result).toEqual(mockResult);
  });

  it('passes countryList and isIncluded to handleRequestSigning for country circuit', async () => {
    vi.mocked(handleRequestSigning).mockResolvedValue({} as any);

    await executeSkill(
      'request_signing',
      {
        circuitId: 'coinbase_country_attestation',
        scope: 'myapp.com',
        countryList: ['US', 'CA'],
        isIncluded: true,
      },
      makeDeps(),
    );

    expect(handleRequestSigning).toHaveBeenCalledWith(
      { circuitId: 'coinbase_country_attestation', scope: 'myapp.com', countryList: ['US', 'CA'], isIncluded: true },
      expect.any(Object),
    );
  });

  // ─── check_status ───────────────────────────────────────────────────────────

  it('routes check_status to handleCheckStatus with requestId', async () => {
    const mockResult = {
      requestId: 'req-abc',
      phase: 'signing' as const,
      signing: { status: 'pending' as const },
      payment: { status: 'not_required' as const },
      expiresAt: '2030-01-01T00:00:00.000Z',
    };
    vi.mocked(handleCheckStatus).mockResolvedValue(mockResult);

    const result = await executeSkill(
      'check_status',
      { requestId: 'req-abc' },
      makeDeps(),
    );

    expect(handleCheckStatus).toHaveBeenCalledOnce();
    expect(handleCheckStatus).toHaveBeenCalledWith(
      { requestId: 'req-abc' },
      expect.any(Object),
    );
    expect(result).toEqual(mockResult);
  });

  // ─── request_payment ────────────────────────────────────────────────────────

  it('routes request_payment to handleRequestPayment with requestId', async () => {
    const mockResult = {
      requestId: 'req-pay-1',
      paymentUrl: 'http://localhost:4002/pay/req-pay-1',
      amount: '$0.10',
      currency: 'USDC',
      network: 'Base Sepolia',
    };
    vi.mocked(handleRequestPayment).mockResolvedValue(mockResult);

    const result = await executeSkill(
      'request_payment',
      { requestId: 'req-pay-1' },
      makeDeps(),
    );

    expect(handleRequestPayment).toHaveBeenCalledOnce();
    expect(handleRequestPayment).toHaveBeenCalledWith(
      { requestId: 'req-pay-1' },
      expect.any(Object),
    );
    expect(result).toEqual(mockResult);
  });

  // ─── generate_proof ─────────────────────────────────────────────────────────

  it('routes generate_proof to handleGenerateProof and returns result without paymentReceiptUrl when no txHash', async () => {
    const mockResult = {
      proof: '0xdeadbeef',
      publicInputs: '0xabcd',
      nullifier: '0x1234',
      signalHash: '0x5678',
      proofId: 'proof-id-1',
      verifyUrl: 'http://localhost:4002/v/proof-id-1',
    };
    vi.mocked(handleGenerateProof).mockResolvedValue(mockResult);

    const result = await executeSkill(
      'generate_proof',
      { requestId: 'req-done' },
      makeDeps(),
    ) as any;

    expect(handleGenerateProof).toHaveBeenCalledOnce();
    expect(handleGenerateProof).toHaveBeenCalledWith(
      {
        requestId: 'req-done',
        address: undefined,
        signature: undefined,
        scope: undefined,
        circuitId: undefined,
        countryList: undefined,
        isIncluded: undefined,
      },
      expect.any(Object),
    );
    expect(result.proof).toBe('0xdeadbeef');
    expect(result.paymentReceiptUrl).toBeUndefined();
  });

  it('adds paymentReceiptUrl to generate_proof result when paymentTxHash is present', async () => {
    const mockResult = {
      proof: '0xdeadbeef',
      publicInputs: '0xabcd',
      nullifier: '0x1234',
      signalHash: '0x5678',
      proofId: 'proof-id-2',
      verifyUrl: 'http://localhost:4002/v/proof-id-2',
      paymentTxHash: '0xabcdef1234567890',
    };
    vi.mocked(handleGenerateProof).mockResolvedValue(mockResult);

    const result = await executeSkill(
      'generate_proof',
      { requestId: 'req-paid' },
      makeDeps(),
    ) as any;

    expect(result.paymentTxHash).toBe('0xabcdef1234567890');
    expect(result.paymentReceiptUrl).toBe(
      'https://sepolia.basescan.org/tx/0xabcdef1234567890',
    );
  });

  it('passes direct-flow params to handleGenerateProof', async () => {
    vi.mocked(handleGenerateProof).mockResolvedValue({} as any);

    await executeSkill(
      'generate_proof',
      {
        address: '0xUserAddress',
        signature: '0xSig',
        scope: 'myapp.com',
        circuitId: 'coinbase_attestation',
      },
      makeDeps(),
    );

    expect(handleGenerateProof).toHaveBeenCalledWith(
      {
        requestId: undefined,
        address: '0xUserAddress',
        signature: '0xSig',
        scope: 'myapp.com',
        circuitId: 'coinbase_attestation',
        countryList: undefined,
        isIncluded: undefined,
      },
      expect.any(Object),
    );
  });

  // ─── verify_proof ───────────────────────────────────────────────────────────

  it('routes verify_proof to handleVerifyProof with correct params', async () => {
    const mockResult = {
      valid: true,
      circuitId: 'coinbase_attestation',
      verifierAddress: '0xVerifier',
      chainId: '84532',
    };
    vi.mocked(handleVerifyProof).mockResolvedValue(mockResult);

    const result = await executeSkill(
      'verify_proof',
      {
        circuitId: 'coinbase_attestation',
        proof: '0xdeadbeef',
        publicInputs: ['0x1111', '0x2222'],
        chainId: '84532',
      },
      makeDeps(),
    );

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
    expect(result).toEqual(mockResult);
  });

  // ─── get_supported_circuits ─────────────────────────────────────────────────

  it('routes get_supported_circuits to handleGetSupportedCircuits', async () => {
    const mockResult = {
      circuits: [
        { id: 'coinbase_attestation', displayName: 'Coinbase KYC', description: '...', requiredInputs: [] },
      ],
      chainId: '84532',
    };
    vi.mocked(handleGetSupportedCircuits).mockReturnValue(mockResult);

    const result = await executeSkill(
      'get_supported_circuits',
      {},
      makeDeps(),
    );

    expect(handleGetSupportedCircuits).toHaveBeenCalledOnce();
    expect(handleGetSupportedCircuits).toHaveBeenCalledWith({ chainId: undefined });
    expect(result).toEqual(mockResult);
  });

  it('passes chainId param to handleGetSupportedCircuits', async () => {
    vi.mocked(handleGetSupportedCircuits).mockReturnValue({ circuits: [], chainId: '8453' });

    await executeSkill('get_supported_circuits', { chainId: '8453' }, makeDeps());

    expect(handleGetSupportedCircuits).toHaveBeenCalledWith({ chainId: '8453' });
  });

  // ─── Unknown skill ──────────────────────────────────────────────────────────

  it('throws for unknown skill name', async () => {
    await expect(
      executeSkill('do_something_unknown', {}, makeDeps()),
    ).rejects.toThrow('Unknown skill: do_something_unknown');
  });

  // ─── Error propagation ──────────────────────────────────────────────────────

  it('propagates errors thrown by handleRequestSigning', async () => {
    vi.mocked(handleRequestSigning).mockRejectedValue(
      new Error('circuitId is required. Use get_supported_circuits to see available circuits.'),
    );

    await expect(
      executeSkill('request_signing', { circuitId: '', scope: 'myapp.com' }, makeDeps()),
    ).rejects.toThrow('circuitId is required');
  });

  it('propagates errors thrown by handleGenerateProof', async () => {
    vi.mocked(handleGenerateProof).mockRejectedValue(
      new Error('Request not found or expired. Create a new request with request_signing.'),
    );

    await expect(
      executeSkill('generate_proof', { requestId: 'stale-id' }, makeDeps()),
    ).rejects.toThrow('Request not found or expired');
  });

  it('propagates errors thrown by handleVerifyProof', async () => {
    vi.mocked(handleVerifyProof).mockRejectedValue(
      new Error('No verifier deployed for circuit "unknown" on chain "84532"'),
    );

    await expect(
      executeSkill('verify_proof', { circuitId: 'unknown', proof: '0x', publicInputs: [] }, makeDeps()),
    ).rejects.toThrow('No verifier deployed');
  });
});
