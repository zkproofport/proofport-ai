/**
 * Paying for a proof, from each wallet a customer can pay with.
 *
 * ## What this covers that the other payment test did not
 *
 * Every other payment test stops at the 402: it asserts the challenge carries
 * a nonce and a payTo and goes no further. That checks the service ASKS for
 * money correctly. It does not check that paying works, which is the half a
 * customer experiences.
 *
 * So these send real money. They are slow, they cost testnet USDC, and they
 * are the only tests here that can say "a paid request returns a proof".
 *
 * ## Two wallets, and why each is here rather than parameterised away
 *
 * | Paying from | Why it needs its own case |
 * |---|---|
 * | a raw private key | the baseline; signs locally with no service in the middle |
 * | a Coinbase CDP wallet | the key never exists locally -- signing is an API call, and CDP's own x402 adapter does the signing, so a change on their side breaks here first |
 *
 * The claim they share -- the buyer signs and never sends a transaction, so it
 * needs no gas -- is checked directly on chain by
 * `scripts/verify-payment.ts`, which measures that the buyer's balance falls
 * by exactly the price. These tests check the same thing through the service
 * instead of directly.
 *
 * ## Skips are stated, never silent
 *
 * A payment test that quietly does not pay is worse than no payment test: it
 * reports green for the case nobody exercised. Each case below names what is
 * missing when it skips -- the credential, or the fact that the service under
 * test is not charging.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  walletFromPrivateKey,
  walletFromCdp,
  signPayment,
  paymentOffers,
  createConfig, generateProof, fromPrivateKey, verifyProof,
} from '@zkproofport-ai/sdk';
import type { PaymentWallet } from '@zkproofport-ai/sdk';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';
const CIRCUIT = 'coinbase_kyc';

/**
 * Where to read a balance, per chain. Public endpoints only — this is a
 * pre-flight check on the buyer's own wallet, not part of the payment.
 */
const RPC_BY_CAIP2: Record<string, string> = {
  'eip155:84532': process.env.CHAIN_RPC_URL || 'https://sepolia.base.org',
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:11155111': process.env.ETHEREUM_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  'eip155:1': 'https://ethereum-rpc.publicnode.com',
};

/** The 402 answer, fetched once. */
let challenge: {
  nonce?: string;
  requiresPayment?: boolean;
  accepts?: Array<Record<string, unknown>>;
} | null = null;
let reachable = false;

/**
 * A USDC balance, or null when it cannot be read.
 *
 * Null rather than throwing: a balance this test cannot fetch is not a reason
 * to fail a payment test, it is a reason to go ahead and let the payment itself
 * be the verdict.
 */
async function usdcBalance(asset: string, holder: string, caip2: string): Promise<bigint | null> {
  const rpc = RPC_BY_CAIP2[caip2];
  if (!rpc) return null;
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: asset, data: `0x70a08231${holder.slice(2).padStart(64, '0')}` }, 'latest'],
      }),
    });
    const body = (await res.json()) as { result?: string };
    return body.result && body.result !== '0x' ? BigInt(body.result) : null;
  } catch {
    return null;
  }
}

async function freshChallenge() {
  const res = await fetch(`${BASE_URL}/api/v1/prove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ circuit: CIRCUIT }),
  });
  expect(res.status).toBe(402);
  return (await res.json()) as typeof challenge & { nonce: string };
}

beforeAll(async () => {
  try {
    challenge = await freshChallenge();
    reachable = true;
  } catch (e) {
    console.warn(`  SKIPPING every payment case: ${BASE_URL} did not answer 402 (${(e as Error).message})`);
  }
}, 30_000);

describe('what the service offers', () => {
  it('names every chain it takes payment on, in CAIP-2', () => {
    if (!reachable) return expect.soft(reachable, `${BASE_URL} unreachable`).toBe(true);
    const offers = paymentOffers(challenge!);
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      // CAIP-2, not a bare name: the v2 scheme registers against CAIP-2.
      expect(o.network, `${o.networkName} offered as '${o.network}'`).toMatch(/^eip155:\d+$/);
      expect(o.asset).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});

/**
 * The shared body of every wallet case: pay, then get a proof.
 *
 * Deliberately re-fetches the challenge. A nonce is single-use, so reusing one
 * across cases would make the second case fail for a reason unrelated to its
 * wallet.
 */
async function paysAndProves(wallet: PaymentWallet, network: string) {
  const fresh = await freshChallenge();
  const offers = paymentOffers(fresh!);
  const wanted = offers.find((o) => o.networkName === network);
  expect(wanted, `${BASE_URL} offers ${offers.map((o) => o.networkName).join(', ')}, not ${network}`).toBeDefined();

  // Does this wallet hold enough? Asked before paying so an unfunded wallet
  // says so, instead of failing several seconds later as a facilitator's
  // "ERC20: transfer amount exceeds balance" buried in a settle error — which
  // reads like the payment code is broken when the only thing missing is money.
  const held = await usdcBalance(wanted!.asset, wallet.address, wanted!.network);
  if (held !== null && held < BigInt(wanted!.amount)) {
    throw new Error(`${wallet.describe()} has ${held} atomic USDC on ${network}; price ${wanted!.amount}. ` +
      'Fund its USDC token balance on this network.');
  }

  const attestationKey = process.env.ATTESTATION_KEY;
  if (!attestationKey) throw new Error('ATTESTATION_KEY required: payment verification must produce a real proof');
  const result = await generateProof(createConfig({ baseUrl: BASE_URL }), {
    attestation: fromPrivateKey(attestationKey), payment: wallet,
  }, { circuit: CIRCUIT, scope: `e2e:payment:${network}`, payOn: network });
  expect(result.proof).toMatch(/^0x[0-9a-f]+$/i);
  const verified = await verifyProof(result);
  expect(verified.valid, verified.error).toBe(true);
  return result;
}

/**
 * The payer's key, under the name the rest of the suite uses.
 *
 * This file read `PAYMENT_PRIVATE_KEY`, which is in no env file here, so every
 * paying case skipped and the run still reported eight passed — a green over a
 * suite that had not paid for anything. `.env.test` carries the payer as
 * `E2E_PAYER_WALLET_KEY`; both names are accepted so an existing environment
 * keeps working, and the absence of both is still a stated skip.
 */
function payerKey(): string | undefined {
  return process.env.PAYMENT_PRIVATE_KEY || process.env.E2E_PAYER_WALLET_KEY;
}

function networkPayerKey(network: string): string | undefined {
  const name = `E2E_PAYER_KEY_${network.toUpperCase().replace(/-/g, '_')}`;
  return process.env[name] || payerKey();
}

describe('each staging payment network independently', () => {
  for (const network of ['base-sepolia', 'ethereum-sepolia']) {
    it(`settles ${network} and returns an on-chain-verifiable proof`, async (context) => {
      expect(reachable, `${BASE_URL} unreachable`).toBe(true);
      if (!challenge!.requiresPayment) { console.warn('SKIP: payment disabled'); return context.skip(); }
      expect(paymentOffers(challenge!).some(o => o.networkName === network), `Required staging network ${network} not offered`).toBe(true);
      const key = networkPayerKey(network);
      if (!key) throw new Error(`Missing payer key for ${network}`);
      await paysAndProves(await walletFromPrivateKey(key), network);
    }, 180_000);
  }
});

describe('paying from a Coinbase CDP wallet', () => {
  it('signs through CDP and buys a proof', async (context) => {
    if (!reachable) return expect.soft(reachable, `${BASE_URL} unreachable`).toBe(true);
    if (!challenge!.requiresPayment) { console.warn('  SKIP: this deployment is not charging'); return context.skip(); }
    const { CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET } = process.env;
    if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET || !CDP_WALLET_SECRET) {
      { console.warn('  SKIP: CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET not set'); return context.skip(); }
    }
    const wallet = await walletFromCdp({
      apiKeyId: CDP_API_KEY_ID,
      apiKeySecret: CDP_API_KEY_SECRET,
      walletSecret: CDP_WALLET_SECRET,
      walletName: process.env.CDP_WALLET_NAME,
    });
    // CDP's wallets live on Base; Base Sepolia when one is offered.
    const offers = paymentOffers(challenge!);
    const network =
      offers.find((o) => o.networkName === 'base-sepolia')?.networkName ??
      offers.find((o) => o.networkName === 'base')?.networkName;
    if (!network) { console.warn('  SKIP: this deployment offers no Base chain for the CDP wallet'); return context.skip(); }
    await paysAndProves(wallet, network);
  }, 180_000);
});

describe('what the service refuses', () => {
  it('refuses a chain it does not take payment on, rather than picking one', async (context) => {
    if (!reachable) return expect.soft(reachable, `${BASE_URL} unreachable`).toBe(true);
    const key = payerKey();
    if (!key) { console.warn('  SKIP: PAYMENT_PRIVATE_KEY not set'); return context.skip(); }
    const wallet = await walletFromPrivateKey(key);
    // Checked client-side: the SDK must not quietly pay on the first chain
    // when the caller named a different one. Spending money somewhere the
    // caller did not choose and reporting success is the failure being
    // guarded against.
    await expect(signPayment(challenge!, wallet, { network: 'solana-mainnet' })).rejects.toThrow(
      /does not take payment on 'solana-mainnet'/,
    );
  });

  it('refuses reuse of a consumed request nonce', async (context) => {
    if (!reachable) return expect.soft(reachable, `${BASE_URL} unreachable`).toBe(true);
    if (!challenge!.requiresPayment) { console.warn('  SKIP: this deployment is not charging'); return context.skip(); }
    const key = payerKey();
    if (!key) { console.warn('  SKIP: PAYMENT_PRIVATE_KEY not set'); return context.skip(); }
    const wallet = await walletFromPrivateKey(key);
    const network = paymentOffers(challenge!)[0].networkName;
    const fresh = await freshChallenge();
    const paid = await signPayment(fresh!, wallet, { network });
    // Consume the request nonce using an explicitly invalid request. This
    // is nonce replay coverage, not a claim that payment settled.
    const initial = await fetch(`${BASE_URL}/api/v1/prove`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...paid.headers }, body: JSON.stringify({ circuit: CIRCUIT }) });
    expect(initial.status).toBe(400);
    expect((await initial.json()).error).toBe('INVALID_REQUEST');

    // The same headers again. The nonce is consumed with GETDEL, so the
    // service must not honour it twice -- one payment, one proof.
    const res = await fetch(`${BASE_URL}/api/v1/prove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...paid.headers },
      body: JSON.stringify({ circuit: CIRCUIT, inputs: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('INVALID_NONCE');
  }, 240_000);
});
