import { ethers } from 'ethers';
import type { PaymentVerificationResult } from './types.js';
import { createLogger } from '../logger.js';
import type { PaymentNetworkId } from '../payment/networks.js';

const log = createLogger('PaymentVerifier');

/**
 * The USDC contract to look for a Transfer event on, per network.
 *
 * Arc is the odd one. USDC is its NATIVE gas asset, and the address below is
 * its ERC-20 interface over the same balance -- one balance, two views, per
 * docs.arc.io/arc/references/evm-differences. A `transfer()` through that
 * interface still emits a Transfer event, so the check below works unchanged;
 * a native value send would NOT, and is handled separately.
 */
const USDC_ADDRESSES: Record<string, string> = {
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'arc-testnet': '0x3600000000000000000000000000000000000000',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'ethereum-sepolia': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
};

/**
 * Networks where USDC is the native gas asset, so a payment can arrive with no
 * Transfer event at all -- as `tx.value` on a plain send.
 *
 * Checking only for the event on such a chain rejects a payment that plainly
 * happened, which reads to the caller as "we did not receive it".
 */
const NATIVE_USDC_NETWORKS = new Set(['arc-testnet']);

// ERC-20 Transfer event topic
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

export async function verifyPaymentOnChain(params: {
  txHash: string;
  expectedRecipient: string;
  expectedNonce: string;
  expectedMinAmount: bigint;
  rpcUrl: string;
  network: PaymentNetworkId;
  /**
   * True when this service settled the payment itself during this request,
   * from an authorization the buyer signed and sent.
   *
   * It changes ONE check: whether the challenge nonce must appear in the
   * transaction's calldata. See the nonce check below for why that check
   * cannot apply here and what replaces it.
   */
  settledByUs?: boolean;
}): Promise<PaymentVerificationResult> {
  const {
    txHash,
    expectedRecipient,
    expectedNonce,
    expectedMinAmount,
    rpcUrl,
    network,
    settledByUs,
  } = params;
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

    let toAddress: string;
    let amount: bigint;

    if (transferLog) {
      // Decode Transfer event: Transfer(from, to, amount)
      toAddress = ethers.getAddress('0x' + transferLog.topics[2].slice(26));
      amount = BigInt(transferLog.data);
    } else if (NATIVE_USDC_NETWORKS.has(network) && tx.to && tx.value > 0n) {
      // A native USDC send on Arc: the value rides on the transaction and
      // there is no event to read. Requiring one here would reject a payment
      // that plainly happened.
      toAddress = ethers.getAddress(tx.to);
      amount = tx.value;
    } else {
      // Nothing moved. Distinct from paying the wrong address, which this used
      // to be reported as -- see the reason codes in ./types.ts.
      log.warn({ action: 'payment.no_transfer', txHash, network, usdcAddress }, 'Transaction moved no USDC');
      return {
        valid: false,
        error: `No USDC transfer found in ${txHash}: no Transfer event from ${usdcAddress}` +
          (NATIVE_USDC_NETWORKS.has(network) ? ' and no native value sent' : ''),
        reason: 'no_transfer',
      };
    }

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

    // Tie the transaction to the challenge it answers.
    //
    // Two payment paths, and they are bound differently because only one of
    // them CAN carry the nonce on chain:
    //
    // A buyer that submits its OWN transaction (`X-Payment-TX`) hands over a
    // hash and nothing else. Any past payment to this service would otherwise
    // buy another proof, so the challenge nonce must appear in that
    // transaction's calldata. This is the only binding available there, and it
    // stays mandatory.
    //
    // A buyer that signs an AUTHORIZATION (`PAYMENT-SIGNATURE`) has no room
    // for it: `transferWithAuthorization` calldata is six fixed fields plus a
    // signature, and the authorization's own nonce is chosen by the x402
    // client. The binding instead is causal and just as tight -- this service
    // settled that authorization, in this request, against the nonce it had
    // just consumed from Redis with GETDEL. Replay is covered twice over: the
    // Redis nonce is single-use, and the same authorization cannot settle a
    // second time because USDC records it in `authorizationState`, so a
    // resent PAYMENT-SIGNATURE fails on chain rather than buying a proof.
    //
    // Requiring the calldata nonce on this path would fail every payment on
    // every chain -- which is exactly what it did, as `nonce_missing`, until
    // this branch was added.
    if (!settledByUs) {
      const txData = tx.data;
      const nonceClean = expectedNonce.startsWith('0x')
        ? expectedNonce.slice(2).toLowerCase()
        : expectedNonce.toLowerCase();

      if (!txData.toLowerCase().includes(nonceClean)) {
        log.warn({ action: 'payment.nonce_missing', expectedNonce, txData, txHash }, 'Payment nonce not found in transaction data');
        return {
          valid: false,
          error:
            'Payment nonce not found in transaction data. A self-submitted payment must carry the ' +
            'challenge nonce in its calldata; to avoid that, sign an authorization and send it as ' +
            'PAYMENT-SIGNATURE instead.',
          reason: 'nonce_missing',
        };
      }
    }

    log.info({ action: 'payment.verified', txHash, amount: amount.toString(), recipient: toAddress }, 'Payment verified on-chain');
    return { valid: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Payment verification failed';
    log.error({ action: 'payment.verify.error', err: error, txHash }, 'Payment verification failed');
    return { valid: false, error: message };
  }
}
