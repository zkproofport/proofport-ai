/**
 * Whether money actually arrived.
 *
 * This function decides whether a proof is handed out, and it had no test at
 * all. Two of the cases below correspond to bugs found on 2026-09-09 by
 * running real payments: the nonce binding differs between the two payment
 * paths, and getting that wrong refused every authorization payment on every
 * chain with `nonce_missing`.
 *
 * The RPC is stubbed rather than reached. What is being checked is the
 * decision, not the chain -- the chain half is checked for real by
 * `scripts/verify-payment.ts`, which moves USDC.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { verifyPaymentOnChain } from '../../src/proof/paymentVerifier.js';

const PAY_TO = '0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c';
const BUYER = '0x1111111111111111111111111111111111111111';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const NONCE = '0x' + 'ab'.repeat(32);

/** A receipt whose Transfer event pays `amount` to `to`. */
function receiptPaying(to: string, amount: bigint) {
  return {
    status: 1,
    logs: [
      {
        address: USDC_BASE_SEPOLIA,
        topics: [
          TRANSFER_TOPIC,
          ethers.zeroPadValue(BUYER, 32),
          ethers.zeroPadValue(to, 32),
        ],
        data: ethers.toBeHex(amount, 32),
      },
    ],
  };
}

function stubRpc(tx: Record<string, unknown>, receipt: Record<string, unknown>) {
  vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransaction').mockResolvedValue(tx as never);
  vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionReceipt').mockResolvedValue(receipt as never);
}

const base = {
  txHash: '0x' + '11'.repeat(32),
  expectedRecipient: PAY_TO,
  expectedNonce: NONCE,
  expectedMinAmount: 10_000n,
  rpcUrl: 'https://example.invalid',
  network: 'base-sepolia' as const,
};

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('a payment this service settled from a signed authorization', () => {
  it('is accepted without the challenge nonce in the calldata', async () => {
    // transferWithAuthorization calldata is six fixed fields plus a signature.
    // There is nowhere to put our nonce, and the x402 client picks the
    // authorization's own nonce. Demanding it here refused every payment on
    // every chain until the two paths were separated.
    stubRpc(
      { data: '0xe3ee160e' + '00'.repeat(100), to: USDC_BASE_SEPOLIA, value: 0n },
      receiptPaying(PAY_TO, 10_000n),
    );
    await expect(verifyPaymentOnChain({ ...base, settledByUs: true })).resolves.toEqual({ valid: true });
  });

  it('is still refused when it paid someone else', async () => {
    // Skipping the nonce check must not skip anything else.
    stubRpc(
      { data: '0xe3ee160e', to: USDC_BASE_SEPOLIA, value: 0n },
      receiptPaying('0x000000000000000000000000000000000000dEaD', 10_000n),
    );
    const r = await verifyPaymentOnChain({ ...base, settledByUs: true });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('wrong_recipient');
  });

  it('is still refused when it paid too little', async () => {
    stubRpc(
      { data: '0xe3ee160e', to: USDC_BASE_SEPOLIA, value: 0n },
      receiptPaying(PAY_TO, 9_999n),
    );
    const r = await verifyPaymentOnChain({ ...base, settledByUs: true });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('insufficient_amount');
  });
});

describe('a payment the buyer submitted itself', () => {
  it('is refused unless the challenge nonce is in the calldata', async () => {
    // The hash is all this service is given, so any past payment to it would
    // otherwise buy another proof. The calldata nonce is the only binding
    // available on this path, and it stays mandatory.
    stubRpc(
      { data: '0xa9059cbb' + '00'.repeat(64), to: USDC_BASE_SEPOLIA, value: 0n },
      receiptPaying(PAY_TO, 10_000n),
    );
    const r = await verifyPaymentOnChain(base);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('nonce_missing');
  });

  it('is accepted when the nonce is there', async () => {
    stubRpc(
      { data: '0xa9059cbb' + NONCE.slice(2), to: USDC_BASE_SEPOLIA, value: 0n },
      receiptPaying(PAY_TO, 10_000n),
    );
    await expect(verifyPaymentOnChain(base)).resolves.toEqual({ valid: true });
  });
});

describe('transactions that did not happen or did not work', () => {
  it('refuses a reverted transaction', async () => {
    stubRpc({ data: '0x', to: USDC_BASE_SEPOLIA, value: 0n }, { status: 0, logs: [] });
    const r = await verifyPaymentOnChain({ ...base, settledByUs: true });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('tx_reverted');
  });

  it('refuses a transaction that moved no USDC at all', async () => {
    // A facilitator can answer with a hash whose transaction did nothing.
    // This is the check that catches it -- settling and verifying are separate
    // so that a facilitator's word is not taken for the money.
    stubRpc({ data: '0x', to: USDC_BASE_SEPOLIA, value: 0n }, { status: 1, logs: [] });
    const r = await verifyPaymentOnChain({ ...base, settledByUs: true });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('no_transfer');
  });
});

describe('Arc, where USDC is the native asset', () => {
  it('accepts a plain native send, scaled from 18 decimals', async () => {
    // Nobody is asked to pay this way -- the offer is an authorization -- but
    // a wallet can do it, and 0.01 USDC then arrives as 1e16 rather than 1e4.
    stubRpc(
      { data: '0x', to: PAY_TO, value: ethers.parseUnits('0.01', 18) },
      { status: 1, logs: [] },
    );
    const r = await verifyPaymentOnChain({
      ...base,
      network: 'arc-testnet',
      settledByUs: true,
    });
    expect(r, `native Arc send was rejected: ${JSON.stringify(r)}`).toEqual({ valid: true });
  });
});
