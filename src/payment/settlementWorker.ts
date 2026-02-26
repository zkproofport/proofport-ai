import { ethers } from 'ethers';
import type { PaymentFacilitator, PaymentRecord } from './facilitator.js';
import { createLogger } from '../logger.js';

const log = createLogger('Settlement');

// Base USDC contract addresses (6 decimals)
const USDC_ADDRESS_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_ADDRESS_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Minimal USDC ERC-20 ABI
const USDC_ABI = [
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
];

export interface SettlementConfig {
  chainRpcUrl: string;
  privateKey: string;
  operatorAddress: string;
  usdcContractAddress: string;
  pollIntervalMs?: number;
}

export class SettlementWorker {
  private facilitator: PaymentFacilitator;
  private config: SettlementConfig;
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private usdcContract: ethers.Contract;
  private pollIntervalMs: number;
  private intervalHandle: NodeJS.Timeout | null = null;
  private retryCount: Map<string, number> = new Map();
  private readonly MAX_RETRIES = 3;

  constructor(facilitator: PaymentFacilitator, config: SettlementConfig) {
    this.facilitator = facilitator;
    this.config = config;
    this.pollIntervalMs = config.pollIntervalMs ?? 30000; // 30 seconds default

    // Initialize ethers v6 provider and wallet
    this.provider = new ethers.JsonRpcProvider(config.chainRpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.usdcContract = new ethers.Contract(config.usdcContractAddress, USDC_ABI, this.wallet);
  }

  start(): void {
    if (this.intervalHandle) {
      log.info({ action: 'settlement.worker.already_running' }, 'SettlementWorker already running');
      return;
    }

    log.info(
      { action: 'settlement.worker.started', pollIntervalMs: this.pollIntervalMs, operatorAddress: this.config.operatorAddress },
      'SettlementWorker started',
    );
    this.intervalHandle = setInterval(() => {
      this.processPendingSettlements().catch((error) => {
        log.error({ action: 'settlement.worker.cycle_error', err: error }, 'Error in settlement processing cycle');
      });
    }, this.pollIntervalMs);

    // Run first cycle immediately
    this.processPendingSettlements().catch((error) => {
      log.error({ action: 'settlement.worker.cycle_error', err: error }, 'Error in initial settlement processing cycle');
    });
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      log.info({ action: 'settlement.worker.stopped' }, 'SettlementWorker stopped');
    }
  }

  async processPendingSettlements(): Promise<void> {
    const pendingPayments = await this.facilitator.listPayments({ status: 'pending' });

    if (pendingPayments.length === 0) {
      return;
    }

    log.info({ action: 'settlement.worker.processing', count: pendingPayments.length }, 'Processing pending settlements');

    for (const payment of pendingPayments) {
      try {
        await this.settleSinglePayment(payment);
      } catch (error) {
        log.error({ action: 'settlement.payment.failed', err: error, paymentId: payment.id }, 'Failed to settle payment');
        // Don't update status - leave as 'pending' for retry in next cycle
      }
    }
  }

  private async settleSinglePayment(payment: PaymentRecord): Promise<void> {
    // Check retry limit
    const currentRetries = this.retryCount.get(payment.id) ?? 0;
    if (currentRetries >= this.MAX_RETRIES) {
      log.error(
        { action: 'settlement.payment.max_retries', paymentId: payment.id, maxRetries: this.MAX_RETRIES },
        'Payment exceeded max retries, skipping until manual intervention',
      );
      return;
    }

    // Parse amount
    let amountInUsdcUnits: bigint;
    try {
      amountInUsdcUnits = parseUsdcAmount(payment.amount);
    } catch (error) {
      log.error(
        { action: 'settlement.payment.parse_error', err: error, paymentId: payment.id, amount: payment.amount },
        'Failed to parse amount for payment',
      );
      return;
    }

    // Execute transfer
    log.info(
      { action: 'settlement.payment.started', paymentId: payment.id, amount: payment.amount, usdcUnits: amountInUsdcUnits.toString(), operatorAddress: this.config.operatorAddress },
      'Settling payment',
    );

    try {
      const tx = await this.usdcContract.transfer(this.config.operatorAddress, amountInUsdcUnits);
      log.info({ action: 'settlement.payment.tx_submitted', paymentId: payment.id, txHash: tx.hash }, 'Transaction submitted for payment');

      const receipt = await tx.wait();
      log.info(
        { action: 'settlement.payment.tx_confirmed', paymentId: payment.id, txHash: tx.hash, blockNumber: receipt.blockNumber },
        'Transaction confirmed for payment',
      );

      // Update status in Redis
      await this.facilitator.settlePayment(payment.id);
      log.info({ action: 'settlement.payment.settled', paymentId: payment.id }, 'Payment settled successfully');

      // Clear retry count on success
      this.retryCount.delete(payment.id);
    } catch (error) {
      // Increment retry count
      this.retryCount.set(payment.id, currentRetries + 1);
      throw error; // Re-throw to log in processPendingSettlements
    }
  }
}

/**
 * Parse USDC amount from string format (e.g., "$0.10", "0.10", "$1.00")
 * USDC has 6 decimals
 */
export function parseUsdcAmount(amount: string): bigint {
  if (!amount) {
    throw new Error('Amount is empty or undefined');
  }

  // Remove leading/trailing whitespace and dollar sign
  const cleaned = amount.trim().replace(/^\$/, '');

  if (!cleaned) {
    throw new Error(`Invalid amount format: ${amount}`);
  }

  // Parse as float and convert to USDC units (6 decimals)
  const numericValue = parseFloat(cleaned);
  if (isNaN(numericValue) || numericValue < 0) {
    throw new Error(`Invalid numeric value: ${amount}`);
  }

  // Multiply by 10^6 and convert to bigint
  const usdcUnits = Math.round(numericValue * 1_000_000);
  return BigInt(usdcUnits);
}
