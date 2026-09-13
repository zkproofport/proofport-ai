import { describe, it, expect } from 'vitest';
import { isBatchPayment } from '@circle-fin/x402-batching';
import { getPaymentNetwork, buildPaymentRequirements, resolvePaymentNetworks } from '../src/payment/networks.js';

/**
 * Arc's nanopayments are offered alongside the ordinary Arc option, and each
 * settles by its own route.
 *
 * The two are different offers a buyer chooses between: one goes on chain
 * immediately and costs gas (measured 2026-09-12: 0.0035 USDC for a 0.001
 * payment, which is absurd for a nanopayment), the other is handed to Circle
 * Gateway's off-chain ledger and settled later in a batch, so the gas per
 * payment approaches zero.
 *
 * What must not happen is the two being confused. Circle's own
 * `supportsBatching` reads the offer's `extra` to tell them apart, so the test
 * asks Circle's function rather than ours.
 */
const arcNano = getPaymentNetwork('arc-testnet-nano')!;
const arcPlain = getPaymentNetwork('arc-testnet')!;

const offer = (net: typeof arcNano) =>
  buildPaymentRequirements({
    networks: [net],
    price: '0.001',
    payTo: '0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c',
    resource: 'http://localhost:4002/api/v1/prove',
    nonce: '0x' + '11'.repeat(32),
    parseUnits: (value, decimals) => BigInt(Math.round(Number(value) * 10 ** decimals)),
  })[0];

describe('Arc nanopayments are offered and routed', () => {
  it('offers the batched option in a shape Circle recognises', () => {
    expect(isBatchPayment(offer(arcNano))).toBe(true);
    expect(offer(arcNano).extra.name).toBe('GatewayWalletBatched');
    expect(offer(arcNano).extra.version).toBe('1');
    // Signed against Gateway's wallet, not against USDC.
    expect(offer(arcNano).extra.verifyingContract).toBe('0x0077777d7EBA4688BDeF3E311b846F25870A19B9');
  });

  it('leaves the ordinary Arc option exactly as it was', () => {
    expect(isBatchPayment(offer(arcPlain))).toBe(false);
    expect(offer(arcPlain).extra.name).toBe('USDC');
    expect(offer(arcPlain).extra.version).toBe('2');
    expect(offer(arcPlain).extra.verifyingContract).toBeUndefined();
  });

  it('offers both on the same chain, so a buyer picks', () => {
    expect(arcNano.chainId).toBe(arcPlain.chainId);
    expect(arcNano.caip2).toBe(arcPlain.caip2);
    expect(arcNano.usdc).toBe(arcPlain.usdc);
  });

  it('routes each to its own settlement', () => {
    expect(arcNano.settlement).toBe('gateway');
    expect(arcPlain.settlement).toBe('payee');
  });

  it('can be named in PAYMENT_NETWORKS alongside the others', () => {
    const chosen = resolvePaymentNetworks('base-sepolia,arc-testnet,arc-testnet-nano');
    expect(chosen.map(net => net.id)).toEqual(['base-sepolia', 'arc-testnet', 'arc-testnet-nano']);
  });

  it('still refuses a chain nobody listed, naming it', () => {
    expect(() => resolvePaymentNetworks('base-sepolia,not-a-chain')).toThrow(/not-a-chain/);
  });
});
