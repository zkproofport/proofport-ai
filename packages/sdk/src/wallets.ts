/**
 * The wallet that pays for a proof.
 *
 * ## One interface, two wallets
 *
 * Paying for a proof means signing one EIP-712 message -- an EIP-3009
 * `TransferWithAuthorization` over USDC. Nothing else. No transaction, no gas,
 * no native balance on the chain being paid on. So a payment wallet needs
 * exactly two things:
 *
 *     { address, signTypedData({ domain, types, primaryType, message }) }
 *
 * which is `ClientEvmSigner` from `@x402/evm`. Every wallet below is a way of
 * getting one:
 *
 * | To pay from | Call | What you need |
 * |---|---|---|
 * | a raw private key | `walletFromPrivateKey` | the key |
 * | a Coinbase CDP server wallet | `walletFromCdp` | CDP API key id + secret + wallet secret |
 *
 * The chain is chosen separately, when paying. A CDP wallet can pay on
 * Ethereum or on Base; wallet and chain are independent, and the
 * earlier version of this file got that wrong by baking one into the other.
 *
 * ## Why the CDP path is thin
 *
 * Coinbase ships the adapter. `@coinbase/cdp-sdk/x402` exports
 * `fromCdpEvmAccount`, which returns exactly this interface, so the CDP path is
 * a call to their function rather than an EIP-712 client written here.
 *
 * The CDP import is lazy. Someone paying from a private key never installs it.
 */

import type { PaymentWallet } from './types.js';

/**
 * Pay from a raw private key.
 *
 * The simplest thing that works, and the right choice for a test or a CI run.
 * The key signs an authorization and nothing else -- it needs a USDC balance
 * on the paying chain and no gas anywhere.
 */
export async function walletFromPrivateKey(privateKey: string): Promise<PaymentWallet> {
  const { privateKeyToAccount } = await import('viem/accounts');
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  return {
    address: account.address,
    signTypedData: (message) => account.signTypedData(message as never),
    describe: () => `private key ${account.address}`,
  };
}

/**
 * Pay from a Coinbase CDP server wallet.
 *
 * Uses CDP's own x402 adapter rather than an EIP-712 client written here, so
 * changes to how CDP signs arrive with a package upgrade instead of a bug.
 *
 * `walletName` names a wallet inside the CDP project; `getOrCreateAccount`
 * makes it on first use, which is what lets a fresh environment pay without a
 * setup step.
 */
export async function walletFromCdp(opts: {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
  walletName?: string;
}): Promise<PaymentWallet> {
  let CdpClient: new (o: Record<string, string>) => {
    evm: { getOrCreateAccount(a: { name: string }): Promise<{ address: string }> };
  };
  let fromCdpEvmAccount: (a: unknown) => { address: string; signTypedData: (m: unknown) => Promise<string> };
  try {
    ({ CdpClient } = (await import('@coinbase/cdp-sdk')) as never);
    ({ fromCdpEvmAccount } = (await import('@coinbase/cdp-sdk/x402')) as never);
  } catch (e) {
    // The original message is included rather than replaced: this fired once
    // saying "install @coinbase/cdp-sdk" when cdp-sdk WAS installed and the
    // missing package was its own peer, `@x402/extensions`. A message that
    // names the wrong cause costs more time than no message.
    throw new Error(
      `Could not load the CDP wallet support. Both @coinbase/cdp-sdk (>=1.55, for its ` +
      `x402 adapter) and its peer @x402/extensions must be installed. ` +
      `Underlying error: ${(e as Error).message}`,
    );
  }
  const cdp = new CdpClient({
    apiKeyId: opts.apiKeyId,
    apiKeySecret: opts.apiKeySecret,
    walletSecret: opts.walletSecret,
  });
  const account = await cdp.evm.getOrCreateAccount({ name: opts.walletName ?? 'zkproofport-payer' });
  const signer = fromCdpEvmAccount(account);
  return {
    address: signer.address as `0x${string}`,
    signTypedData: (message) => signer.signTypedData(message) as Promise<`0x${string}`>,
    describe: () => `CDP wallet ${opts.walletName ?? 'zkproofport-payer'} (${signer.address})`,
  };
}

/**
 * The wallet a set of environment variables describes, or an error saying
 * which variables would have been needed.
 *
 * Deliberately refuses to pick when two wallets are configured, rather than
 * preferring one. A machine holding both a private key and a CDP credential has no
 * obvious default, and silently choosing means the money leaves an account the
 * caller did not name.
 */
export async function walletFromEnv(env: Record<string, string | undefined> = process.env): Promise<PaymentWallet> {
  const configured: string[] = [];
  if (env.PAYMENT_PRIVATE_KEY) configured.push('key');
  if (env.CDP_API_KEY_ID) configured.push('cdp');

  if (configured.length === 0) {
    throw new Error(
      'No payment wallet configured. Set one of:\n' +
      '  PAYMENT_PRIVATE_KEY\n' +
      '  CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET',
    );
  }
  if (configured.length > 1) {
    throw new Error(
      `More than one payment wallet is configured (${configured.join(', ')}). ` +
      `Name the one to use rather than leaving it to be guessed.`,
    );
  }
  return walletFor(configured[0], env);
}

/** The wallet named by `which`, built from `env`. */
export async function walletFor(
  which: string,
  env: Record<string, string | undefined> = process.env,
): Promise<PaymentWallet> {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`Paying from a ${which} wallet requires ${name}`);
    return v;
  };
  switch (which) {
    case 'key':
      return walletFromPrivateKey(need('PAYMENT_PRIVATE_KEY'));
    case 'cdp':
      return walletFromCdp({
        apiKeyId: need('CDP_API_KEY_ID'),
        apiKeySecret: need('CDP_API_KEY_SECRET'),
        walletSecret: need('CDP_WALLET_SECRET'),
        walletName: env.CDP_WALLET_NAME,
      });
    default:
      throw new Error(`Unknown payment wallet '${which}'. Choose one of: key, cdp`);
  }
}
