/**
 * The wallet that pays for a proof.
 *
 * ## One interface, three wallets
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
 * | a Circle wallet, including on Arc | `walletFromCircle` | Circle API key + entity secret + wallet id |
 *
 * The chain is chosen separately, when paying. A CDP wallet can pay on Arc and
 * a Circle wallet can pay on Base; wallet and chain are independent, and the
 * earlier version of this file got that wrong by baking one into the other.
 *
 * ## Why the CDP and Circle paths are thin
 *
 * Both vendors ship the adapter. `@coinbase/cdp-sdk/x402` exports
 * `fromCdpEvmAccount`, which returns exactly this interface, so the CDP path is
 * a call to their function rather than an EIP-712 client written here. Circle
 * has no x402 adapter, so `walletFromCircle` is the one adapter this file
 * really implements -- eleven lines around `signTypedData`, which is all Circle
 * needs to participate.
 *
 * Both imports are lazy. Someone paying from a private key installs neither.
 */

import type { PaymentWallet } from './types.js';
import { walletFromArcAgent } from './arcWallet.js';

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
 * Pay from a Circle developer-controlled wallet -- the way to pay on Arc.
 *
 * Arc is Circle's chain and USDC is its gas asset, so a Circle wallet holding
 * USDC there can pay without holding anything else. `ARC-TESTNET` is the
 * blockchain name in Circle's own SDK types; it is not needed for signing (an
 * authorization is chain-agnostic once the domain names the chain id) and is
 * only used when this wallet is asked which chain it was created for.
 *
 * Note that Arc needs no special case in the payment path itself. Asked
 * directly on 2026-09-09, Arc's USDC at 0x3600...0000 answers name()="USDC",
 * version()="2", decimals()=6, and a DOMAIN_SEPARATOR() that matches what a
 * client computes from those values -- so an Arc authorization is an ordinary
 * USDC authorization and this wallet is an ordinary signer.
 */
export async function walletFromCircle(opts: {
  apiKey: string;
  entitySecret: string;
  walletId: string;
  /** The wallet's address. Read from Circle when omitted. */
  address?: string;
}): Promise<PaymentWallet> {
  let initiateDeveloperControlledWalletsClient: (o: Record<string, string>) => {
    signTypedData(i: { walletId: string; data: string; memo?: string }): Promise<{ data?: { signature?: string } }>;
    getWallet(i: { id: string }): Promise<{ data?: { wallet?: { address?: string } } }>;
  };
  try {
    ({ initiateDeveloperControlledWalletsClient } = (await import(
      '@circle-fin/developer-controlled-wallets'
    )) as never);
  } catch (e) {
    throw new Error(
      `Paying from a Circle wallet needs @circle-fin/developer-controlled-wallets installed: ` +
      `npm i @circle-fin/developer-controlled-wallets (${(e as Error).message})`,
    );
  }
  const circle = initiateDeveloperControlledWalletsClient({
    apiKey: opts.apiKey,
    entitySecret: opts.entitySecret,
  });

  let address = opts.address;
  if (!address) {
    const got = await circle.getWallet({ id: opts.walletId });
    address = got.data?.wallet?.address;
    if (!address) {
      throw new Error(`Circle wallet ${opts.walletId} has no address; check the wallet id and the API key`);
    }
  }

  return {
    address: address as `0x${string}`,
    async signTypedData(message) {
      const res = await circle.signTypedData({
        walletId: opts.walletId,
        data: JSON.stringify(message),
        memo: 'ZKProofport proof generation fee',
      });
      const signature = res.data?.signature;
      if (!signature) {
        throw new Error(
          `Circle wallet ${opts.walletId} returned no signature. A wallet can only sign on a chain it was ` +
          `created for -- check it exists on the chain named in the payment's domain.`,
        );
      }
      return signature as `0x${string}`;
    },
    describe: () => `Circle wallet ${opts.walletId} (${address})`,
  };
}

/**
 * The wallet a set of environment variables describes, or an error saying
 * which variables would have been needed.
 *
 * Deliberately refuses to pick when two wallets are configured, rather than
 * preferring one. A machine holding both a CDP and a Circle credential has no
 * obvious default, and silently choosing means the money leaves an account the
 * caller did not name.
 */
export async function walletFromEnv(env: Record<string, string | undefined> = process.env): Promise<PaymentWallet> {
  const configured: string[] = [];
  if (env.PAYMENT_PRIVATE_KEY) configured.push('key');
  if (env.CDP_API_KEY_ID) configured.push('cdp');
  if (env.CIRCLE_API_KEY) configured.push('circle');

  if (configured.length === 0) {
    throw new Error(
      'No payment wallet configured. Set one of:\n' +
      '  PAYMENT_PRIVATE_KEY\n' +
      '  CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET\n' +
      '  CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET + CIRCLE_WALLET_ID',
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
    case 'arc':
      // No credentials here: Circle's CLI holds the login, and the wallet is
      // whichever agent wallet that login has on Arc. `ARC_AGENT_WALLET` names
      // one when an account has several.
      return walletFromArcAgent({
        address: env.ARC_AGENT_WALLET,
        chain: (env.ARC_CLI_CHAIN as never) ?? undefined,
      });
    case 'circle':
      return walletFromCircle({
        apiKey: need('CIRCLE_API_KEY'),
        entitySecret: need('CIRCLE_ENTITY_SECRET'),
        walletId: need('CIRCLE_WALLET_ID'),
        address: env.CIRCLE_WALLET_ADDRESS,
      });
    default:
      throw new Error(`Unknown payment wallet '${which}'. Choose one of: key, cdp, circle, arc`);
  }
}
