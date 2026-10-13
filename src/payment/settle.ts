/**
 * Turning a buyer's signed authorization into money, on any of the chains in
 * `networks.ts`.
 *
 * ## What the buyer does, and does not, have to do
 *
 * The buyer signs an EIP-3009 `TransferWithAuthorization` and sends it. It
 * never submits a transaction and never needs a gas balance -- not on Base,
 * not on Ethereum. That is the whole point of the x402 `exact`
 * scheme, and it is what the first version of this service's payment support
 * did before it was deleted (see `packages/sdk/src/cdp.ts` for that history).
 *
 * ## Why this file exists rather than only a facilitator URL
 *
 * A public facilitator submits the authorization and eats the gas. Asked on
 * 2026-09-09, `x402.dexter.cash` does that for Base, Polygon, Arbitrum,
 * Optimism, Avalanche, BSC, World Chain, Monad, SKALE and Solana, and
 * `x402.org/facilitator` for Base Sepolia. Neither serves Ethereum mainnet or
 * Ethereum Sepolia.
 *
 * So for the Ethereum chains this service settles the payment itself, using the
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

import { createWalletClient, http, publicActions } from 'viem';
import { getSettlementAccount } from './settlementAccount.js';
import * as chains from 'viem/chains';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentNetwork } from './networks.js';
import { settleWithFacilitator } from './facilitator.js';

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

/** A facilitator that settles one chain, built from that chain's own values. */
function facilitatorFor(net: PaymentNetwork) {
  const chain = viemChain(net);
  const account = getSettlementAccount(process.env.PROVER_PRIVATE_KEY || '', process.env.PAYMENT_PAY_TO || '');
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
  via: 'facilitator' | 'payee';
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
  const { payload, requirements, network } = params;

  if (network.settlement === 'facilitator') {
    return settleWithFacilitator(payload, requirements, network);
  }

  const facilitator = facilitatorFor(network);
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
