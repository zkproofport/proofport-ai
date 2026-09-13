/**
 * Paying with Arc nanopayments: deposit once, then pay many times for free.
 *
 * ## What is different from the ordinary path
 *
 * An ordinary x402 payment puts one authorization on chain per purchase, and
 * on Arc that costs gas in USDC — measured 2026-09-12 at 0.0035 USDC to settle
 * a payment of 0.001, which is four times the price of the thing being bought.
 * That is fine for a one-off and absurd for an agent buying thousands of
 * proofs.
 *
 * Circle Gateway takes the same EIP-3009 authorization, verifies it off chain
 * in under a second, and settles thousands of them in one transaction. The
 * buyer's money moves into Gateway once, by depositing; after that each
 * payment is a signature and nothing more.
 *
 * ## What the buyer has to do
 *
 * Deposit first. A signature drawn against a Gateway balance that is not there
 * is refused, and the refusal names the balance rather than the signature, so
 * `ensureGatewayBalance` checks before paying rather than after failing.
 */

import { GatewayClient } from '@circle-fin/x402-batching/client';

/** Arc Testnet, as `@circle-fin/x402-batching` names it. */
export const ARC_GATEWAY_CHAIN = 'arcTestnet' as const;

export interface NanopaymentWallet {
  /** The buyer's key. Gateway signs authorizations with it and never sends a transaction per payment. */
  privateKey: `0x${string}`;
  /** Arc's RPC. Required — the package's default is for Arc mainnet. */
  rpcUrl: string;
}

/** What a buyer holds inside Gateway, in USDC's smallest units. */
export interface GatewayBalances {
  /** Spendable right now. */
  available: bigint;
  /** On the way out, not spendable. */
  withdrawing: bigint;
}

function client(wallet: NanopaymentWallet): GatewayClient {
  return new GatewayClient({
    chain: ARC_GATEWAY_CHAIN,
    privateKey: wallet.privateKey,
    rpcUrl: wallet.rpcUrl,
  });
}

/** What the buyer currently has inside Gateway. */
export async function gatewayBalance(wallet: NanopaymentWallet): Promise<GatewayBalances> {
  const balance = await client(wallet).getBalance();
  return { available: balance.available, withdrawing: balance.withdrawing };
}

/**
 * Make sure the buyer can pay `atLeast`, depositing `topUp` if not.
 *
 * Deposits are the one on-chain step in this flow and they cost gas, so this
 * is deliberately not called before every payment — an agent deposits once and
 * spends against it.
 */
export async function ensureGatewayBalance(
  wallet: NanopaymentWallet,
  /** In USDC's smallest units. Undefined requests an unconditional deposit. */
  atLeast: bigint | undefined,
  /** In whole USDC, like everything the deposit call takes. */
  topUp: string,
): Promise<{ deposited: boolean; balance: GatewayBalances; depositTxHash?: string }> {
  const before = await gatewayBalance(wallet);
  if (atLeast !== undefined && before.available >= atLeast) return { deposited: false, balance: before };

  const result = await client(wallet).deposit(topUp);
  return {
    deposited: true,
    balance: await gatewayBalance(wallet),
    depositTxHash: result.depositTxHash,
  };
}

/**
 * Buy something priced in x402, paying through Gateway.
 *
 * The 402 answer must carry a batched offer; a service that offers only the
 * ordinary on-chain options is not reachable this way, and saying so is better
 * than silently paying the expensive way.
 */
export async function payWithNanopayments<T = unknown>(
  wallet: NanopaymentWallet,
  url: string,
  options?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ data: T; amount: string }> {
  const gateway = client(wallet);
  const supported = await gateway.supports(url);
  if (!supported.supported) {
    throw new Error(
      `${url} offers no batched payment option, so it cannot be paid through Circle Gateway. ` +
      `Pay it the ordinary way, or have the service offer arc-testnet-nano.`,
    );
  }
  const paid = await gateway.pay<T>(url, options as never);
  return { data: paid.data as T, amount: String((paid as { amount?: unknown }).amount ?? '0') };
}
