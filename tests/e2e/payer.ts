/**
 * The wallet the proof suites pay with, and the chain they pay on.
 *
 * Three things went wrong on staging on 2026-09-22 that this file exists to
 * stop repeating:
 *
 *   - the suites passed `fromPrivateKey(...)`, which is an attestation signer
 *     with `getAddress()`, into `signers.payment`, which needs a PaymentWallet
 *     with `.address`. viem then reported `Address "undefined" is invalid`,
 *     which names neither the wallet nor the mix-up. The tests are not
 *     typechecked (tsconfig covers src only), so nothing caught it.
 *   - they named `payOn: 'base-sepolia'` while that deployment offers only
 *     `arc-testnet-nano`. A test may not decide which chain a service takes.
 *   - when the payer cannot settle, the failure has to SAY so. "Circle Gateway
 *     failed to settle arc-testnet-nano: insufficient_balance" is the useful
 *     sentence; an assertion on `isError` is not.
 */
import { requestChallenge, walletFromPrivateKey, type ClientConfig, type PaymentWallet } from '@zkproofport-ai/sdk';

export type PayerPlan =
  | { wallet: PaymentWallet; payOn: string; free: false }
  | { wallet: undefined; payOn: undefined; free: true };

/**
 * Ask the service what it charges and prepare to pay it.
 *
 * `free` means the deployment is not charging — payment is then not part of
 * what the test measures, and no wallet is needed.
 */
export async function planPayment(
  config: ClientConfig,
  circuit: string,
  privateKey: string,
): Promise<PayerPlan> {
  const challenge = await requestChallenge(config, circuit as never);
  if (challenge.requiresPayment === false) {
    return { wallet: undefined, payOn: undefined, free: true };
  }
  const offers = (challenge.accepts ?? []) as Array<{ networkName?: string; network?: string }>;
  const requested = process.env.E2E_PAYMENT_NETWORK;
  const offer = requested ? offers.find(o => o.networkName === requested) : offers[0];
  if (requested && !offer) throw new Error(`Requested E2E payment network ${requested} is not offered by ${config.baseUrl}`);
  const payOn = offer?.networkName ?? offer?.network;
  if (!payOn) {
    throw new Error(
      `${config.baseUrl} says it charges but offered no chain to pay on. ` +
      `Challenge: ${JSON.stringify(challenge).slice(0, 400)}`,
    );
  }
  return { wallet: await walletFromPrivateKey(privateKey), payOn, free: false };
}

/**
 * The remedy sentence for a payment that could not settle, or null when the
 * failure is something else and must be reported as a failure.
 *
 * Only a missing balance is turned into a stated skip: the money is outside
 * this repository and no code change fixes it. Everything else is a defect.
 */
export function unfundedReason(error: unknown, payOn: string, payer?: string): string | null {
  const text = error instanceof Error ? error.message : String(error);
  if (!/insufficient_balance|insufficient funds|ERC20: transfer amount exceeds balance/i.test(text)) {
    return null;
  }
  return (
    `the payer has nothing to spend on ${payOn}` +
    (payer ? ` (${payer})` : '') +
    (payOn === 'arc-testnet-nano' ? '. Deposit USDC into Circle Gateway.' : '. Fund its USDC balance on the selected chain.') +
    ` Service said: ${text.slice(0, 200)}`
  );
}
