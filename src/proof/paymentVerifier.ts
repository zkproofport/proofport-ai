import { ethers } from 'ethers';
import type { PaymentVerificationResult } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('PaymentVerifier');

// USDC addresses
const USDC_ADDRESSES: Record<string, string> = {
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

// ERC-20 Transfer event topic
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

export async function verifyPaymentOnChain(params: {
  txHash: string;
  expectedRecipient: string;
  expectedNonce: string;
  expectedMinAmount: bigint;
  rpcUrl: string;
  network: 'base-sepolia' | 'base';
}): Promise<PaymentVerificationResult> {
  const { txHash, expectedRecipient, expectedNonce, expectedMinAmount, rpcUrl, network } = params;
  const usdcAddress = USDC_ADDRESSES[network];

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    log.info({ action: 'payment.verify.start', txHash, network, rpcUrl }, 'Verifying payment on-chain');

    // Get transaction and receipt
    let tx = null;
    let receipt = null;
    // Retry loop: facilitator tx may not be visible on public RPC immediately
    for (let attempt = 0; attempt < 5; attempt++) {
      [tx, receipt] = await Promise.all([
        provider.getTransaction(txHash),
        provider.getTransactionReceipt(txHash),
      ]);
      if (tx) break;
      if (attempt < 4) {
        log.info({ action: 'payment.verify.retry', attempt: attempt + 1, txHash }, 'Transaction not found yet, retrying...');
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (!tx) {
      return { valid: false, error: 'Transaction not found after retries', reason: 'tx_not_found' };
    }

    if (!receipt) {
      return { valid: false, error: 'Transaction is pending (not yet confirmed)', reason: 'tx_pending' };
    }

    if (receipt.status !== 1) {
      return { valid: false, error: 'Transaction reverted', reason: 'tx_reverted' };
    }

    // Check USDC Transfer event in receipt logs
    const transferLog = receipt.logs.find(logEntry =>
      logEntry.address.toLowerCase() === usdcAddress.toLowerCase() &&
      logEntry.topics[0] === TRANSFER_TOPIC
    );

    if (!transferLog) {
      return { valid: false, error: 'No USDC transfer found in transaction', reason: 'wrong_recipient' };
    }

    // Decode Transfer event: Transfer(from, to, amount)
    const toAddress = ethers.getAddress('0x' + transferLog.topics[2].slice(26));
    const amount = BigInt(transferLog.data);

    // Check recipient
    if (toAddress.toLowerCase() !== expectedRecipient.toLowerCase()) {
      log.warn({ action: 'payment.wrong_recipient', expected: expectedRecipient, actual: toAddress, txHash }, 'Wrong payment recipient');
      return { valid: false, error: `Wrong recipient: expected ${expectedRecipient}, got ${toAddress}`, reason: 'wrong_recipient' };
    }

    // Check amount
    if (amount < expectedMinAmount) {
      log.warn({ action: 'payment.insufficient_amount', expected: expectedMinAmount.toString(), actual: amount.toString(), txHash }, 'Insufficient payment amount');
      return { valid: false, error: `Insufficient amount: expected ${expectedMinAmount}, got ${amount}`, reason: 'insufficient_amount' };
    }

    // Check nonce in transaction data field
    const txData = tx.data;
    // The nonce should be present somewhere in the calldata
    const nonceClean = expectedNonce.startsWith('0x') ? expectedNonce.slice(2).toLowerCase() : expectedNonce.toLowerCase();

    // Check in tx input data (for transfer with data) or in Transfer event data
    if (!txData.toLowerCase().includes(nonceClean)) {
      log.warn({ action: 'payment.nonce_missing', expectedNonce, txData, txHash }, 'Payment nonce not found in transaction data');
      return { valid: false, error: 'Payment nonce not found in transaction data', reason: 'nonce_missing' };
    }

    log.info({ action: 'payment.verified', txHash, amount: amount.toString(), recipient: toAddress }, 'Payment verified on-chain');
    return { valid: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Payment verification failed';
    log.error({ action: 'payment.verify.error', err: error, txHash }, 'Payment verification failed');
    return { valid: false, error: message };
  }
}
