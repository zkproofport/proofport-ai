import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock freeTier — the only external dependency we need to control
vi.mock('../../src/payment/freeTier.js', () => ({
  getPaymentModeConfig: vi.fn(),
}));

import { createPaymentRecordingMiddleware } from '../../src/payment/recordingMiddleware.js';
import { getPaymentModeConfig } from '../../src/payment/freeTier.js';

const mockGetPaymentModeConfig = vi.mocked(getPaymentModeConfig);

// Real CBOR-encoded base64 payloads (generated via cbor-x encode).
// The source uses require('cbor-x') dynamically so we use real data
// instead of mocking the module.
const ENCODED = {
  // { proof: { from: '0xAbCd...' }, amount: '$0.10' }
  proofFrom:
    'uQACZXByb29muQABZGZyb214KjB4QWJDZDEyMzRBYkNkMTIzNEFiQ2QxMjM0QWJDZDEyMzRBYkNkMTIzNGZhbW91bnRlJDAuMTA=',
  // { from: '0x5678...', amount: '$0.10' }
  flatFrom:
    'uQACZGZyb214KjB4NTY3ODAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwNTY3OGZhbW91bnRlJDAuMTA=',
  // { proof: { from: '0xDeAdBeEf...' } }  — no amount field
  noAmount:
    'uQABZXByb29muQABZGZyb214KjB4RGVBZEJlRWYwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMQ==',
  // { proof: { from: '0x1111...' }, amount: '$0.10' }
  networkTest:
    'uQACZXByb29muQABZGZyb214KjB4MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMWZhbW91bnRlJDAuMTA=',
  // { proof: { from: '0x2222...' }, amount: '$0.10' }
  mainnetTest:
    'uQACZXByb29muQABZGZyb214KjB4MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMmZhbW91bnRlJDAuMTA=',
  // { scheme: 'exact', network: 'eip155:84532' }  — no from field
  missingFrom: 'uQACZnNjaGVtZWVleGFjdGduZXR3b3JrbGVpcDE1NTo4NDUzMg==',
  // null
  nullValue: '9g==',
} as const;

function makeFacilitator() {
  return {} as any;
}

function testnetConfig() {
  return {
    mode: 'testnet' as const,
    network: 'eip155:84532',
    requiresPayment: true,
    description: 'Testnet USDC on Base Sepolia',
  };
}

function mainnetConfig() {
  return {
    mode: 'mainnet' as const,
    network: 'eip155:8453',
    requiresPayment: true,
    description: 'Mainnet USDC on Base',
  };
}

function disabledConfig() {
  return {
    mode: 'disabled' as const,
    network: null,
    requiresPayment: false,
    description: 'Payment disabled (development mode)',
  };
}

describe('createPaymentRecordingMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls next() when payment mode is disabled', async () => {
    mockGetPaymentModeConfig.mockReturnValue(disabledConfig());

    const middleware = createPaymentRecordingMiddleware({
      paymentMode: 'disabled',
      facilitator: makeFacilitator(),
    });
    const mockReq = { headers: {} } as unknown as Request;
    const mockRes = {} as Response;
    const mockNext = vi.fn() as unknown as NextFunction;

    await middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledOnce();
    expect((mockReq as any).x402Payment).toBeUndefined();
  });

  it('calls next() when no x-payment header is present (testnet)', async () => {
    mockGetPaymentModeConfig.mockReturnValue(testnetConfig());

    const middleware = createPaymentRecordingMiddleware({
      paymentMode: 'testnet',
      facilitator: makeFacilitator(),
    });
    const mockReq = { headers: {} } as unknown as Request;
    const mockRes = {} as Response;
    const mockNext = vi.fn() as unknown as NextFunction;

    await middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledOnce();
    expect((mockReq as any).x402Payment).toBeUndefined();
  });

  it('parses valid x-payment header and sets req.x402Payment', async () => {
    mockGetPaymentModeConfig.mockReturnValue(testnetConfig());

    const middleware = createPaymentRecordingMiddleware({
      paymentMode: 'testnet',
      facilitator: makeFacilitator(),
    });
    const mockReq = {
      headers: { 'x-payment': ENCODED.proofFrom },
    } as unknown as Request;
    const mockRes = {} as Response;
    const mockNext = vi.fn() as unknown as NextFunction;

    await middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledOnce();
    expect((mockReq as any).x402Payment).toEqual({
      payerAddress: '0xAbCd1234AbCd1234AbCd1234AbCd1234AbCd1234',
      amount: '$0.10',
      network: 'eip155:84532',
    });
  });

  it('uses payment.from fallback when proof.from is missing', async () => {
    mockGetPaymentModeConfig.mockReturnValue(testnetConfig());

    const middleware = createPaymentRecordingMiddleware({
      paymentMode: 'testnet',
      facilitator: makeFacilitator(),
    });
    const mockReq = {
      headers: { 'x-payment': ENCODED.flatFrom },
    } as unknown as Request;
    const mockRes = {} as Response;
    const mockNext = vi.fn() as unknown as NextFunction;

    await middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledOnce();
    expect((mockReq as any).x402Payment.payerAddress).toBe(
      '0x5678000000000000000000000000000000005678',
    );
  });

  it('calls next() on parse error (non-blocking)', async () => {
    mockGetPaymentModeConfig.mockReturnValue(testnetConfig());

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const middleware = createPaymentRecordingMiddleware({
      paymentMode: 'testnet',
      facilitator: makeFacilitator(),
    });
    // Pass completely non-base64/non-CBOR garbage that will cause decode to throw
    const mockReq = {
      headers: { 'x-payment': '!!!INVALID_CBOR_DATA!!!' },
    } as unknown as Request;
    const mockRes = {} as Response;
    const mockNext = vi.fn() as unknown as NextFunction;

    await middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('sets default amount $0.10 when payment has no amount field', async () => {
    mockGetPaymentModeConfig.mockReturnValue(testnetConfig());

    const middleware = createPaymentRecordingMiddleware({
      paymentMode: 'testnet',
      facilitator: makeFacilitator(),
    });
    const mockReq = {
      headers: { 'x-payment': ENCODED.noAmount },
    } as unknown as Request;
    const mockRes = {} as Response;
    const mockNext = vi.fn() as unknown as NextFunction;

    await middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledOnce();
    expect((mockReq as any).x402Payment.amount).toBe('$0.10');
  });

  it('sets network from payment mode config (testnet)', async () => {
    mockGetPaymentModeConfig.mockReturnValue(testnetConfig());

    const middleware = createPaymentRecordingMiddleware({
      paymentMode: 'testnet',
      facilitator: makeFacilitator(),
    });
    const mockReq = {
      headers: { 'x-payment': ENCODED.networkTest },
    } as unknown as Request;
    const mockRes = {} as Response;
    const mockNext = vi.fn() as unknown as NextFunction;

    await middleware(mockReq, mockRes, mockNext);

    expect((mockReq as any).x402Payment.network).toBe('eip155:84532');
  });

  it('sets mainnet network when payment mode is mainnet', async () => {
    mockGetPaymentModeConfig.mockReturnValue(mainnetConfig());

    const middleware = createPaymentRecordingMiddleware({
      paymentMode: 'mainnet',
      facilitator: makeFacilitator(),
    });
    const mockReq = {
      headers: { 'x-payment': ENCODED.mainnetTest },
    } as unknown as Request;
    const mockRes = {} as Response;
    const mockNext = vi.fn() as unknown as NextFunction;

    await middleware(mockReq, mockRes, mockNext);

    expect((mockReq as any).x402Payment.network).toBe('eip155:8453');
  });
});

describe('parsePaymentHeader edge cases (tested via middleware)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPaymentModeConfig.mockReturnValue(testnetConfig());
  });

  it('handles empty header string (treated as falsy — skips parsing)', async () => {
    const middleware = createPaymentRecordingMiddleware({
      paymentMode: 'testnet',
      facilitator: makeFacilitator(),
    });
    const mockReq = {
      headers: { 'x-payment': '' },
    } as unknown as Request;
    const mockRes = {} as Response;
    const mockNext = vi.fn() as unknown as NextFunction;

    await middleware(mockReq, mockRes, mockNext);

    // Empty string is falsy — middleware short-circuits before parsing
    expect(mockNext).toHaveBeenCalledOnce();
    expect((mockReq as any).x402Payment).toBeUndefined();
  });

  it('handles invalid base64/CBOR and calls next() without throwing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const middleware = createPaymentRecordingMiddleware({
      paymentMode: 'testnet',
      facilitator: makeFacilitator(),
    });
    const mockReq = {
      headers: { 'x-payment': 'not-valid-cbor-at-all-####' },
    } as unknown as Request;
    const mockRes = {} as Response;
    const mockNext = vi.fn() as unknown as NextFunction;

    await middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('handles CBOR with missing from field — logs error, calls next()', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const middleware = createPaymentRecordingMiddleware({
      paymentMode: 'testnet',
      facilitator: makeFacilitator(),
    });
    // ENCODED.missingFrom decodes to { scheme: 'exact', network: '...' } — no from/proof.from
    const mockReq = {
      headers: { 'x-payment': ENCODED.missingFrom },
    } as unknown as Request;
    const mockRes = {} as Response;
    const mockNext = vi.fn() as unknown as NextFunction;

    await middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('handles CBOR decoding to null — logs error, calls next()', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const middleware = createPaymentRecordingMiddleware({
      paymentMode: 'testnet',
      facilitator: makeFacilitator(),
    });
    // ENCODED.nullValue decodes to null
    const mockReq = {
      headers: { 'x-payment': ENCODED.nullValue },
    } as unknown as Request;
    const mockRes = {} as Response;
    const mockNext = vi.fn() as unknown as NextFunction;

    await middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
