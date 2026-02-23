import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { SettlementWorker, parseUsdcAmount } from '../../src/payment/settlementWorker.js';
import type { PaymentFacilitator, PaymentRecord } from '../../src/payment/facilitator.js';

// Mock logger (vi.hoisted ensures availability before vi.mock hoisting)
const mockLog = vi.hoisted(() => ({
  info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({
  createLogger: () => mockLog,
}));

// Mock ethers
vi.mock('ethers', () => {
  const mockContract = {
    transfer: vi.fn(),
  };

  const mockWallet = vi.fn(() => mockWallet);

  const mockProvider = vi.fn(() => mockProvider);

  return {
    ethers: {
      JsonRpcProvider: mockProvider,
      Wallet: mockWallet,
      Contract: vi.fn(() => mockContract),
    },
  };
});

describe('parseUsdcAmount', () => {
  it('parses "$0.10" to 100000n', () => {
    const result = parseUsdcAmount('$0.10');
    expect(result).toBe(100000n);
  });

  it('parses "$1.00" to 1000000n', () => {
    const result = parseUsdcAmount('$1.00');
    expect(result).toBe(1000000n);
  });

  it('parses "0.50" without dollar sign to 500000n', () => {
    const result = parseUsdcAmount('0.50');
    expect(result).toBe(500000n);
  });

  it('parses "$10.00" to 10000000n', () => {
    const result = parseUsdcAmount('$10.00');
    expect(result).toBe(10000000n);
  });

  it('throws on empty string', () => {
    expect(() => parseUsdcAmount('')).toThrow('Amount is empty or undefined');
  });

  it('throws on invalid format "abc"', () => {
    expect(() => parseUsdcAmount('abc')).toThrow('Invalid numeric value');
  });

  it('handles "$0.01" (1 cent) to 10000n', () => {
    const result = parseUsdcAmount('$0.01');
    expect(result).toBe(10000n);
  });
});

describe('SettlementWorker', () => {
  let mockFacilitator: PaymentFacilitator;
  let mockContract: any;
  let worker: SettlementWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Reset mock contract
    mockContract = {
      transfer: vi.fn().mockResolvedValue({
        hash: '0xmockhash',
        wait: vi.fn().mockResolvedValue({ blockNumber: 12345 }),
      }),
    };

    // Mock ethers.Contract to return our mock contract
    (ethers.Contract as any).mockImplementation(() => mockContract);

    // Mock facilitator
    mockFacilitator = {
      listPayments: vi.fn().mockResolvedValue([]),
      settlePayment: vi.fn().mockResolvedValue(undefined),
    } as any;

    worker = new SettlementWorker(mockFacilitator, {
      chainRpcUrl: 'https://mock-rpc.example.com',
      privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      operatorAddress: '0xOperatorAddress',
      usdcContractAddress: '0xUSDCAddress',
      pollIntervalMs: 1000,
    });
  });

  it('constructor initializes with config', () => {
    expect(worker).toBeDefined();
    expect(ethers.JsonRpcProvider).toHaveBeenCalledWith('https://mock-rpc.example.com');
    expect(ethers.Wallet).toHaveBeenCalled();
    expect(ethers.Contract).toHaveBeenCalledWith('0xUSDCAddress', expect.any(Array), expect.anything());
  });

  it('start() begins polling', () => {
    worker.start();

    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ pollIntervalMs: expect.any(Number) }),
      'SettlementWorker started',
    );
  });

  it('stop() clears interval', () => {
    worker.start();
    worker.stop();

    expect(mockLog.info).toHaveBeenCalledWith('SettlementWorker stopped');
  });

  it('start() when already running logs and returns', () => {
    worker.start();
    worker.start();

    expect(mockLog.info).toHaveBeenCalledWith('SettlementWorker already running');
  });

  it('processPendingSettlements with no pending payments returns early', async () => {
    (mockFacilitator.listPayments as any).mockResolvedValue([]);

    await worker.processPendingSettlements();

    expect(mockFacilitator.listPayments).toHaveBeenCalledWith({ status: 'pending' });
    expect(mockFacilitator.settlePayment).not.toHaveBeenCalled();
  });

  it('processPendingSettlements calls settleSinglePayment for each pending', async () => {
    const mockPayments: PaymentRecord[] = [
      {
        id: 'payment-1',
        clientId: 'client-1',
        requestId: 'request-1',
        amount: '$0.10',
        status: 'pending',
        createdAt: Date.now(),
      },
      {
        id: 'payment-2',
        clientId: 'client-2',
        requestId: 'request-2',
        amount: '$0.20',
        status: 'pending',
        createdAt: Date.now(),
      },
    ];

    (mockFacilitator.listPayments as any).mockResolvedValue(mockPayments);

    await worker.processPendingSettlements();

    expect(mockFacilitator.listPayments).toHaveBeenCalledWith({ status: 'pending' });
    expect(mockContract.transfer).toHaveBeenCalledTimes(2);
    expect(mockFacilitator.settlePayment).toHaveBeenCalledTimes(2);
    expect(mockFacilitator.settlePayment).toHaveBeenCalledWith('payment-1');
    expect(mockFacilitator.settlePayment).toHaveBeenCalledWith('payment-2');
  });

  it('settlement flow: parse amount → transfer → wait → settlePayment', async () => {
    const mockPayment: PaymentRecord = {
      id: 'payment-test',
      clientId: 'client-test',
      requestId: 'request-test',
      amount: '$1.00',
      status: 'pending',
      createdAt: Date.now(),
    };

    (mockFacilitator.listPayments as any).mockResolvedValue([mockPayment]);

    await worker.processPendingSettlements();

    expect(mockContract.transfer).toHaveBeenCalledWith('0xOperatorAddress', 1000000n);
    expect(mockContract.transfer).toHaveBeenCalledTimes(1);

    const txResult = await mockContract.transfer.mock.results[0].value;
    expect(txResult.wait).toHaveBeenCalled();

    expect(mockFacilitator.settlePayment).toHaveBeenCalledWith('payment-test');
  });

  it('settlement clears retry count on success', async () => {
    const mockPayment: PaymentRecord = {
      id: 'payment-retry-test',
      clientId: 'client-test',
      requestId: 'request-test',
      amount: '$0.50',
      status: 'pending',
      createdAt: Date.now(),
    };

    // First call fails
    mockContract.transfer.mockRejectedValueOnce(new Error('Network error'));
    (mockFacilitator.listPayments as any).mockResolvedValue([mockPayment]);

    await worker.processPendingSettlements();

    // Second call succeeds
    mockContract.transfer.mockResolvedValueOnce({
      hash: '0xsuccesshash',
      wait: vi.fn().mockResolvedValue({ blockNumber: 99999 }),
    });

    await worker.processPendingSettlements();

    expect(mockFacilitator.settlePayment).toHaveBeenCalledWith('payment-retry-test');
    expect(mockContract.transfer).toHaveBeenCalledTimes(2);
  });

  it('failed settlement increments retry count', async () => {
    const mockPayment: PaymentRecord = {
      id: 'payment-fail',
      clientId: 'client-test',
      requestId: 'request-test',
      amount: '$0.30',
      status: 'pending',
      createdAt: Date.now(),
    };

    mockContract.transfer.mockRejectedValue(new Error('Transfer failed'));
    (mockFacilitator.listPayments as any).mockResolvedValue([mockPayment]);

    await worker.processPendingSettlements();

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'payment-fail' }),
      'Failed to settle payment',
    );
  });

  it('payment exceeding max retries (3) is skipped', async () => {
    const mockPayment: PaymentRecord = {
      id: 'payment-max-retry',
      clientId: 'client-test',
      requestId: 'request-test',
      amount: '$0.40',
      status: 'pending',
      createdAt: Date.now(),
    };

    mockContract.transfer.mockRejectedValue(new Error('Always fail'));
    (mockFacilitator.listPayments as any).mockResolvedValue([mockPayment]);

    // Attempt 1
    await worker.processPendingSettlements();
    expect(mockContract.transfer).toHaveBeenCalledTimes(1);

    // Attempt 2
    await worker.processPendingSettlements();
    expect(mockContract.transfer).toHaveBeenCalledTimes(2);

    // Attempt 3
    await worker.processPendingSettlements();
    expect(mockContract.transfer).toHaveBeenCalledTimes(3);

    // Attempt 4 - should be skipped
    await worker.processPendingSettlements();
    expect(mockContract.transfer).toHaveBeenCalledTimes(3); // Still 3, not 4

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'payment-max-retry', maxRetries: 3 }),
      expect.stringContaining('exceeded max retries'),
    );
  });
});
