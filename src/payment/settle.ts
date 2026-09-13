/**
 * Turning a buyer's signed authorization into money, on any of the chains in
 * `networks.ts`.
 *
 * ## What the buyer does, and does not, have to do
 *
 * The buyer signs an EIP-3009 `TransferWithAuthorization` and sends it. It
 * never submits a transaction and never needs a gas balance -- not on Base,
 * not on Ethereum, not on Arc. That is the whole point of the x402 `exact`
 * scheme, and it is what the first version of this service's payment support
 * did before it was deleted (see `packages/sdk/src/cdp.ts` for that history).
 *
 * ## Why this file exists rather than only a facilitator URL
 *
 * A public facilitator submits the authorization and eats the gas. Asked on
 * 2026-09-09, `x402.dexter.cash` does that for Base, Polygon, Arbitrum,
 * Optimism, Avalanche, BSC, World Chain, Monad, SKALE and Solana, and
 * `x402.org/facilitator` for Base Sepolia. Neither serves Arc. Neither serves
 * Ethereum mainnet either.
 *
 * So for those chains this service settles the payment itself, using the
 * facilitator implementation that ships in `@x402/evm/exact/facilitator` --
 * the same code a public facilitator runs. It is the payee: paying a few cents
 * of gas out of the payment it is collecting is in its own interest, and it
 * keeps the buyer's side identical on every chain.
 *
 * ## Why not hand-roll the EIP-3009 encoding
 *
 * It was hand-rolled, twice. The version deleted in April signed the
 * authorization by hand and posted a settle body assembled by hand; the
 * version written earlier today skipped authorizations altogether and had the
 * buyer send a transaction, which needs gas the buyer may not have on that
 * chain. Meanwhile `@x402/core`, `@x402/evm`, `@x402/express` and `@x402/fetch`
 * were already dependencies of this service -- declared, mocked in four
 * integration tests, and imported by no source file. This file uses them.
 */

import { createPublicClient, createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as chains from 'viem/chains';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentNetwork } from './networks.js';
import { isBatchPayment } from '@circle-fin/x402-batching';
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server';

/** The viem chain for one of our networks. Absence is an error, never a guess. */
function viemChain(net: PaymentNetwork) {
  const found = Object.values(chains).find(
    (c): c is typeof chains.base => !!c && typeof c === 'object' && 'id' in c && c.id === net.chainId,
  );
  if (!found) {
    throw new Error(
      `viem has no chain definition for ${net.id} (chainId ${net.chainId}). ` +
      `Settling requires one; add it with defineChain rather than defaulting to another chain.`,
    );
  }
  return found;
}

function rpcFor(net: PaymentNetwork): string {
  return process.env[net.rpcEnv] || net.defaultRpc;
}

/**
 * The wallet that submits authorizations for `settlement: 'payee'` chains.
 *
 * Deliberately its own key rather than `PROVER_PRIVATE_KEY`. That key signs
 * this agent's identity and attestations; a key that moves money is a
 * different job with a different blast radius, and sharing one means an
 * identity key has to sit on every chain the service takes payment on.
 *
 * Required -- not defaulted -- whenever a payee-settled chain is offered. The
 * error names the variable and the chains that need it, because the failure
 * would otherwise appear as a payment that verifies and never arrives.
 */
function settlerAccount(nets: PaymentNetwork[]) {
  const key = process.env.PAYMENT_SETTLER_PRIVATE_KEY;
  if (!key) {
    const which = nets.filter((n) => n.settlement === 'payee').map((n) => n.id).join(', ');
    throw new Error(
      `PAYMENT_SETTLER_PRIVATE_KEY is required: no public x402 facilitator settles ${which}, ` +
      `so this service submits the buyer's authorization itself and needs a funded wallet ` +
      `on those chains. Set it, or remove those chains from PAYMENT_NETWORKS.`,
    );
  }
  return privateKeyToAccount(key.startsWith('0x') ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`));
}

/** A facilitator that settles one chain, built from that chain's own values. */
function facilitatorFor(net: PaymentNetwork, nets: PaymentNetwork[]) {
  const chain = viemChain(net);
  const account = settlerAccount(nets);
  const wallet = createWalletClient({ account, chain, transport: http(rpcFor(net)) }).extend(publicActions);
  // One argument on the pinned @x402/evm 2.3.0. Later versions take a
  // `confirmationTimeoutMs` that bounds the receipt wait, which is worth having
  // -- an unbounded wait on a slow chain is killed by the request deadline and
  // the buyer is told nothing happened even though the money moved. Passing it
  // here would not fail loudly, it would fail as an ignored argument, so the
  // bound waits for the upgrade instead of being faked.
  // Spelled out rather than `{ ...wallet } as never`.
  //
  // A viem client and `FacilitatorEvmSigner` differ in exactly one method:
  // viem's `verifyTypedData` accepts a wider parameter type whose some
  // branches require a block to verify against, so passing the client whole
  // needs a cast -- and a cast over the whole object would also swallow a
  // future change to `writeContract`, `readContract` or
  // `waitForTransactionReceipt`, which are the methods that actually move
  // money. So only the one incompatible method is adapted, and everything else
  // stays type-checked.
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    getCode: wallet.getCode,
    readContract: wallet.readContract,
    writeContract: wallet.writeContract,
    sendTransaction: wallet.sendTransaction,
    waitForTransactionReceipt: wallet.waitForTransactionReceipt,
    verifyTypedData: (args) =>
      wallet.verifyTypedData(args as Parameters<typeof wallet.verifyTypedData>[0]),
  } as Parameters<typeof toFacilitatorEvmSigner>[0]);
  const facilitator = new x402Facilitator();
  facilitator.register(net.caip2, new ExactEvmScheme(signer));
  return facilitator;
}

export interface SettleOutcome {
  txHash: string;
  /** Which route actually moved the money, for the log and the report. */
  via: 'facilitator' | 'payee' | 'gateway';
  facilitatorUrl?: string;
}

/**
 * Settle a payment payload and return the transaction that carried it.
 *
 * The caller then verifies that transaction on chain exactly as it verifies a
 * buyer-submitted one -- settlement and verification stay separate, so a
 * facilitator that lies about a hash is caught by the same check as a buyer
 * who does.
 */
export async function settlePayment(params: {
  payload: unknown;
  requirements: unknown;
  network: PaymentNetwork;
  networks: PaymentNetwork[];
}): Promise<SettleOutcome> {
  const { payload, requirements, network, networks } = params;

  // Circle Gateway's batched settlement -- what Arc calls nanopayments. The
  // authorization is handed to Gateway's off-chain ledger, which verifies it
  // in under a second and settles it later alongside thousands of others, so
  // the gas per payment approaches zero. Nothing goes on chain here, and there
  // is no transaction hash to return for this one payment; the batch has one.
  //
  // Routed by `isBatchPayment`, Circle's own check, rather than by our network
  // id: the offer carries what it is, and a buyer that picked a different
  // offer must not land here.
  if (network.settlement === 'gateway' || isBatchPayment(requirements as { extra?: Record<string, unknown> })) {
    if (network.settlement !== 'gateway') {
      throw new Error(
        `A batched authorization arrived for '${network.id}', which does not offer batched settlement. ` +
        `Gateway settles only the chains marked settlement:'gateway' in networks.ts.`,
      );
    }
    // Named, not defaulted. The package's default is the mainnet Gateway,
    // which answers `unsupported_network` for a testnet chain — measured both
    // ways on 2026-09-13. Circle's starter kit gets away with the default
    // because it reads a GATEWAY_API_URL from its own environment.
    const gateway = new BatchFacilitatorClient({ url: network.batching!.gatewayUrl });

    // Gateway wants the resource inside the payload, and x402's own encoder
    // does not put it there — it lives on the requirement, which is where the
    // buyer read it from. Copied across rather than invented: the two must
    // name the same resource or Gateway verifies an authorization for
    // something other than what was offered.
    const req = (requirements ?? {}) as { resource?: unknown; description?: unknown; mimeType?: unknown };
    const withResource =
      payload && typeof payload === 'object' && !(payload as { resource?: unknown }).resource && typeof req.resource === 'string'
        ? {
            ...(payload as Record<string, unknown>),
            // Gateway wants the resource as an object; x402's requirement
            // carries the same three values flat. Same strings, regrouped.
            resource: {
              url: req.resource,
              description: String(req.description ?? ''),
              mimeType: String(req.mimeType ?? 'application/json'),
            },
          }
        : payload;

    const verified = await gateway.verify(withResource as never, requirements as never);
    if (!verified.isValid) {
      throw new Error(
        `Circle Gateway refused the authorization for ${network.id}: ${verified.invalidReason ?? 'no reason given'}`,
      );
    }
    const settled = await gateway.settle(withResource as never, requirements as never);
    if (!settled.success) {
      throw new Error(
        `Circle Gateway failed to settle ${network.id}: ${settled.errorReason ?? 'no reason given'}`,
      );
    }
    return { via: 'gateway', txHash: settled.transaction ?? null };
  }

  if (network.settlement === 'facilitator') {
    const url = network.facilitatorUrl;
    if (!url) {
      throw new Error(
        `${network.id} is marked settlement:'facilitator' with no facilitatorUrl. ` +
        `Name the facilitator in networks.ts or mark the chain settlement:'payee'.`,
      );
    }
    const res = await fetch(`${url}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`facilitator ${url} refused to settle ${network.id}: HTTP ${res.status} ${text}`);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`facilitator ${url} answered ${network.id} settle with non-JSON: ${text}`);
    }
    // Checked BEFORE the hash: a facilitator can answer with a placeholder
    // transaction alongside an error, and reading the hash first turns a
    // failed payment into a proof handed out for nothing. This exact ordering
    // was a comment in the version deleted in April; it is kept.
    if (body.errorReason) {
      throw new Error(`facilitator ${url} failed to settle ${network.id}: ${String(body.errorReason)}`);
    }
    const txHash =
      (body.txHash as string) ||
      ((body.transaction as { hash?: string })?.hash) ||
      (typeof body.transaction === 'string' ? body.transaction : undefined);
    if (!txHash) {
      throw new Error(`facilitator ${url} settled ${network.id} without naming a transaction: ${text}`);
    }
    return { txHash, via: 'facilitator', facilitatorUrl: url };
  }

  const facilitator = facilitatorFor(network, networks);
  const result = (await facilitator.settle(
    payload as Parameters<typeof facilitator.settle>[0],
    requirements as Parameters<typeof facilitator.settle>[1],
  )) as {
    success?: boolean;
    errorReason?: string;
    transaction?: string;
  };
  if (result.errorReason || result.success === false) {
    throw new Error(
      `settling ${network.id} from this service's own wallet failed: ${result.errorReason ?? 'no reason given'}`,
    );
  }
  if (!result.transaction) {
    throw new Error(`settling ${network.id} produced no transaction hash`);
  }
  return { txHash: result.transaction, via: 'payee' };
}
