/**
 * The requirement this service emits can actually be signed.
 *
 * ## The gap this closes
 *
 * Two pieces have to agree and are written in different places: the 402 body
 * comes from `buildPaymentRequirements` here, and the signature comes from
 * `@x402/evm`'s exact scheme inside the SDK. Nothing made them agree except
 * that both were written on the same day.
 *
 * The specific worry is the fields this service adds beyond the standard --
 * `networkName` alongside `network`, and `nonce` and `caip2` inside `extra`.
 * If the official client validates a requirement strictly, those extras are
 * rejected and every payment fails at signing time with a schema error, on
 * every chain at once. That is not something the on-chain check catches: it
 * signs a requirement built by hand, not one from this service.
 *
 * These run offline. No RPC, no service, no money -- a signature over typed
 * data needs none of those, which is the same reason a buyer needs no gas.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { buildPaymentRequirements, getPaymentNetwork } from '../../src/payment/networks.js';
import { signPayment, paymentOffers } from '../../packages/sdk/src/payment.js';
import { walletFromPrivateKey } from '../../packages/sdk/src/wallets.js';

// A fixed throwaway key, so a failure is reproducible.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const NONCE = '0x' + '11'.repeat(32);

function challengeOffering(...networks: string[]) {
  const nets = networks.map((n) => {
    const net = getPaymentNetwork(n);
    if (!net) throw new Error(`test names an unknown chain: ${n}`);
    return net;
  });
  return {
    nonce: NONCE,
    requiresPayment: true,
    accepts: buildPaymentRequirements({
      networks: nets,
      price: '0.01',
      payTo: '0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c',
      resource: 'https://ai.zkproofport.app/api/v1/prove',
      nonce: NONCE,
      parseUnits: (v, d) => ethers.parseUnits(v, d),
    }) as unknown as Array<Record<string, unknown>>,
  };
}

describe('signing what this service asks for', () => {
  it('signs an Arc requirement, extra fields and all', async () => {
    const wallet = await walletFromPrivateKey(KEY);
    const paid = await signPayment(challengeOffering('arc-testnet'), wallet, { network: 'arc-testnet' });

    // `PAYMENT-SIGNATURE` is the v2 header name, paired with the
    // `PAYMENT-REQUIRED` header the 402 carries. Asserted by name rather than
    // by "whatever came back", because the server has to read the same one --
    // and reading the v1 `X-Payment` instead makes every v2 payment arrive
    // looking like no payment at all.
    const header = paid.headers['PAYMENT-SIGNATURE'];
    expect(header, `headers were ${Object.keys(paid.headers).join(', ')}`).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(JSON.stringify(decoded)).toMatch(/0x[0-9a-fA-F]{130}/); // a signature is in there
    expect(paid.paidOn).toBe('arc-testnet');
    expect(paid.payer).toBe(new ethers.Wallet(KEY).address);
    // Our own challenge nonce rides alongside, not inside, the x402 payload.
    expect(paid.headers['X-Payment-Nonce']).toBe(NONCE);
  });

  it('signs every chain this service can offer', async () => {
    const wallet = await walletFromPrivateKey(KEY);
    for (const chain of ['base-sepolia', 'base', 'ethereum', 'ethereum-sepolia', 'arc-testnet']) {
      const paid = await signPayment(challengeOffering(chain), wallet, { network: chain });
      expect(paid.paidOn, `signing failed for ${chain}`).toBe(chain);
    }
  });

  it('signs the chain asked for, not the first offered', async () => {
    const wallet = await walletFromPrivateKey(KEY);
    const challenge = challengeOffering('base-sepolia', 'arc-testnet', 'ethereum-sepolia');
    const paid = await signPayment(challenge, wallet, { network: 'arc-testnet' });
    expect(paid.paidOn).toBe('arc-testnet');

    // Named by CAIP-2 too, since that is what the offer carries.
    const byCaip2 = await signPayment(challenge, wallet, { network: 'eip155:5042002' });
    expect(byCaip2.paidOn).toBe('arc-testnet');
  });

  it('refuses a chain that was not offered instead of paying elsewhere', async () => {
    const wallet = await walletFromPrivateKey(KEY);
    await expect(
      signPayment(challengeOffering('base-sepolia'), wallet, { network: 'arc-testnet' }),
    ).rejects.toThrow(/does not take payment on 'arc-testnet'/);
  });

  it('takes the first offer when no chain is named', async () => {
    const wallet = await walletFromPrivateKey(KEY);
    const paid = await signPayment(challengeOffering('arc-testnet', 'base'), wallet);
    expect(paid.paidOn).toBe('arc-testnet');
  });
});

describe('what the offer says', () => {
  it('prices each chain in its own units', () => {
    const offers = paymentOffers(challengeOffering('arc-testnet', 'base'));
    // Both are 6-decimal USDC, Arc included -- its 18 decimals belong to a
    // native send, not to a quote. 0.01 USDC is 10000 either way.
    for (const o of offers) {
      expect(BigInt(o.amount), `${o.networkName} priced at ${o.amount}`).toBe(10_000n);
    }
  });

  it('names chains in CAIP-2, which is the only form that can carry Arc', () => {
    for (const o of paymentOffers(challengeOffering('arc-testnet', 'base', 'ethereum'))) {
      expect(o.network).toMatch(/^eip155:\d+$/);
    }
    expect(paymentOffers(challengeOffering('arc-testnet'))[0].network).toBe('eip155:5042002');
  });

  it('rebuilds a requirement identically, which is what settling depends on', () => {
    // Settling verifies the buyer's signature against a requirement rebuilt
    // server-side. One differing field -- a re-rounded price, a regenerated
    // nonce -- fails as an invalid signature and reads like the buyer signed
    // wrongly.
    const first = challengeOffering('arc-testnet').accepts;
    const second = challengeOffering('arc-testnet').accepts;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
