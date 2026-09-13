/**
 * Paying for a proof.
 *
 * ## What happens
 *
 * 1. Ask for a proof with no payment. The service answers 402 with a list of
 *    chains it will take payment on (`accepts`), each with a price in that
 *    chain's USDC and a one-time nonce.
 * 2. Pick a chain. Sign an EIP-3009 authorization for it. Send it back.
 * 3. The service settles the authorization and returns the proof.
 *
 * The buyer signs. It never submits a transaction, so it needs no gas and no
 * native balance on the chain it pays on -- only USDC. That holds on Base, on
 * Ethereum and on Arc alike.
 *
 * ## Why this file is short
 *
 * Because the encoding is not written here. `@x402/evm`'s exact scheme builds
 * and signs the authorization and `@x402/core`'s HTTP client encodes the
 * header, which between them is the part that is easy to get subtly wrong --
 * the v1 and v2 header formats differ, the USDC EIP-712 domain name differs
 * between mainnet ("USD Coin") and testnets ("USDC"), and a wrong domain
 * produces a valid signature over the wrong message that fails with no hint.
 *
 * This was written by hand twice before. In April a settle body was assembled
 * field by field and posted to a facilitator; earlier today the authorization
 * was skipped altogether in favour of the buyer sending its own transaction,
 * which needs gas the buyer may not have and cannot work on a chain where no
 * proof-of-payment is expected. Both were replaced by this.
 *
 * ## Which chains
 *
 * Any EVM chain the service offers. The v2 scheme registers as an `eip155:*`
 * wildcard, so nothing here holds a chain list -- Arc included, which is the
 * reason the offer is CAIP-2 (`eip155:5042002`) rather than a bare name. The
 * bare names are a fixed 24-chain table inside `@x402/evm` and Arc is not in
 * it.
 */

import type { PaymentWallet, PaymentOffer, PaidRequest, ApprovedPayment } from './types.js';
import { usdcSpendControls, isKnownUsdc, knownUsdc, DEFAULT_MAX_PAYMENT } from './usdc.js';

/**
 * The chains a 402 answer will take payment on, in the order offered.
 *
 * Reading this before paying is what lets a caller choose -- "pay on Arc" is a
 * filter over this list, not a separate code path.
 */
export function paymentOffers(challenge: {
  accepts?: unknown[];
  payment?: unknown;
  requiresPayment?: boolean;
}): PaymentOffer[] {
  const raw = (challenge.accepts ?? (challenge.payment ? [challenge.payment] : [])) as Array<
    Record<string, unknown>
  >;
  return raw.map((r) => ({
    network: String(r.network),
    networkName: r.networkName ? String(r.networkName) : String(r.network),
    // `amount` is the v2 name; `maxAmountRequired` was v1's. Both read, so
    // an older service still parses.
    amount: String(r.amount ?? r.maxAmountRequired ?? '0'),
    asset: String(r.asset ?? ''),
    payTo: String(r.payTo ?? ''),
    raw: r,
  }));
}

/**
 * Sign payment for one of the offers and return the headers to retry with.
 *
 * `network` names the chain to pay on, as either the CAIP-2 id
 * (`eip155:5042002`) or the plain name (`arc-testnet`). Omitting it takes the
 * first offer, which is the order the service listed its chains in.
 *
 * An unmatched name is an error listing what was offered. It is never a
 * silent fall back to the first chain: paying on a chain the caller did not
 * ask for spends real money in the wrong place, and the caller who typed
 * `--network arc` would be told the payment succeeded.
 */
export function assertApprovedPayment(offer:PaymentOffer,approved:ApprovedPayment){
  const extra=offer.raw.extra as Record<string,unknown>|undefined;
  const sameAddress=(a:unknown,b:string)=>typeof a==='string'&&/^0x[0-9a-fA-F]{40}$/.test(a)&&a.toLowerCase()===b.toLowerCase();
  if(offer.network!==approved.network||offer.raw.scheme!==approved.scheme||offer.amount!==approved.amount||
    !sameAddress(offer.asset,approved.asset)||!sameAddress(offer.payTo,approved.payTo)||
    extra?.name!==approved.extra.name||extra?.version!==approved.extra.version||!sameAddress(extra?.verifyingContract,approved.extra.verifyingContract)){
    throw Error('The actual payment offer differs from the user-approved amount, recipient, asset, network or signing domain. Refusing to sign.');
  }
}

export async function signPayment(
  challenge: { accepts?: unknown[]; payment?: unknown; nonce?: string },
  wallet: PaymentWallet,
  opts: { network?: string; maxPayment?: string; approvedPayment?:ApprovedPayment } = {},
): Promise<PaidRequest> {
  const offers = paymentOffers(challenge);
  if (offers.length === 0) {
    throw new Error('The service named no chains it takes payment on; nothing to pay');
  }

  let offer = offers[0];
  if (opts.network) {
    const wanted = opts.network.toLowerCase();
    const found = offers.find(
      (o) => o.network.toLowerCase() === wanted || o.networkName.toLowerCase() === wanted,
    );
    if (!found) {
      throw new Error(
        `The service does not take payment on '${opts.network}'. It offers: ` +
        offers.map((o) => `${o.networkName} (${o.network})`).join(', '),
      );
    }
    offer = found;
  }

  if(opts.approvedPayment)assertApprovedPayment(offer,opts.approvedPayment);
  // Checked here so the refusal names the token. @x402/core would also
  // refuse -- that is what spend controls are for -- but its message talks
  // about allowedAssets and does not say what was asked for.
  if (!isKnownUsdc(offer.network, offer.asset)) {
    throw new Error(
      `${offer.networkName} payment was requested in token ${offer.asset}, which is not the USDC ` +
      `this SDK knows for that chain` +
      (knownUsdc(offer.network) ? ` (${knownUsdc(offer.network)})` : ' (no USDC known for it at all)') +
      `. Refusing to sign: a 402 answer names the token it wants, and signing whatever it names ` +
      `lets a service ask to be paid in anything.`,
    );
  }

  // x402's top-level USD cap does not cover custom allowed assets such as
  // Arc USDC. Enforce the same six-decimal limit on the selected offer here,
  // before invoking any signer, whether or not exact terms were supplied.
  const maximum = opts.maxPayment ?? DEFAULT_MAX_PAYMENT;
  const match = /^\$?(\d+)(?:\.(\d{1,6}))?$/.exec(maximum);
  if (!match) throw new Error('Invalid maximum USDC payment: use a non-negative decimal with up to six places.');
  const maximumUnits = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  if (!/^\d+$/.test(offer.amount)) throw new Error('The USDC payment offer must use integer atomic units.');
  if (BigInt(offer.amount) > maximumUnits) {
    throw new Error(`The payment offer exceeds the maximum ${maximum} USDC payment. Refusing to sign.`);
  }

  const { x402Client, x402HTTPClient } = await import('@x402/core/client');
  const { registerExactEvmScheme } = await import('@x402/evm/exact/client');
  const { supportsBatching } = await import('@circle-fin/x402-batching');
  const { registerBatchScheme } = await import('@circle-fin/x402-batching/client');

  // Spend controls stay ON. Arc's USDC is not among the library's default
  // assets, so paying there needs the assets named -- not the control
  // disabled, which would allow any token on any chain.
  const client = new x402Client();
  client.setSpendControls(usdcSpendControls(opts.maxPayment) as never);

  // How the authorization gets signed depends on the offer.
  //
  // A batched offer is signed against Circle Gateway's wallet contract, not
  // against USDC, and the two signatures are not interchangeable: registering
  // the ordinary scheme and then the batched one leaves the ordinary one
  // signing, which Gateway rejects as `unauthorized` -- a valid signature over
  // the wrong thing. Circle's own way is to hand the ordinary scheme in as the
  // fallback, so ONE composite scheme picks per offer.
  if (supportsBatching(offer.raw as { extra?: Record<string, unknown> })) {
    const { ExactEvmScheme } = await import('@x402/evm/exact/client');
    registerBatchScheme(client as never, {
      signer: wallet as never,
      fallbackScheme: new (ExactEvmScheme as never as new (s: unknown) => unknown)(wallet) as never,
    } as never);
  } else {
    registerExactEvmScheme(client, { signer: wallet as never });
  }
  const http = new x402HTTPClient(client);

  const payload = await client.createPaymentPayload({
    x402Version: 2,
    accepts: [offer.raw],
  } as never);
  const headers = http.encodePaymentSignatureHeader(payload);

  return {
    headers: {
      ...headers,
      // The service's own nonce, which ties this payment to the challenge it
      // answers. Sent alongside the x402 header rather than inside it: the
      // nonce is ours, not part of the standard, and it is what stops a
      // settled payment being replayed against a second proof request.
      ...(challenge.nonce ? { 'X-Payment-Nonce': challenge.nonce } : {}),
    },
    paidOn: offer.networkName,
    amount: offer.amount,
    payer: wallet.address,
  };
}
