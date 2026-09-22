/**
 * Paying from an Arc agent wallet, through Circle's CLI.
 *
 * ## Why the CLI and not an API
 *
 * An Arc agent wallet is not a key this process can hold. Circle keeps it, and
 * everything that touches it — creating it, reading its balance, signing with
 * it — goes through `@circle-fin/cli`, which authenticates with a login that a
 * person does once. So the integration is a wrapper around that command, and
 * the alternative would be reimplementing Circle's auth, which is both work and
 * a second thing to get wrong.
 *
 * ## What this buys over a private key
 *
 * The wallet carries policies Circle enforces: spending limits per period,
 * recipient allowlists, contract blocklists. A raw key has none of that — it
 * signs whatever it is handed. That is the whole point of an agent holding
 * money: the agent acts on its own, and the limits are not the agent's to
 * ignore.
 *
 * ## What it costs
 *
 * A subprocess per signature, and the CLI must be installed and logged in. Both
 * are checked before signing rather than discovered as a cryptic failure, and
 * the errors here say which of the two is missing and what command fixes it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PaymentWallet } from './types.js';

const run = promisify(execFile);

/** How Circle names Arc's chains. Not ours to choose. */
export const ARC_CLI_CHAINS = { testnet: 'ARC-TESTNET', mainnet: 'ARC' } as const;
export type ArcCliChain = (typeof ARC_CLI_CHAINS)[keyof typeof ARC_CLI_CHAINS];

async function circle(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await run('circle', [...args, '--output', 'json'], {
      // Non-interactive: a script has no way to answer the terms prompt, and
      // Circle documents this variable for exactly that.
      env: { ...process.env, CIRCLE_ACCEPT_TERMS: '1' },
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      throw new Error(
        'Circle CLI is not installed, so an Arc agent wallet cannot sign. Install it with ' +
        '`npm install -g @circle-fin/cli`, then `circle wallet login <email> --testnet`.',
      );
    }
    // The CLI prints a JSON error on stdout even when it exits non-zero.
    let reason = err.stderr?.trim() || err.message || 'unknown error';
    try {
      const parsed = JSON.parse(err.stdout ?? '') as { error?: { message?: string; hint?: string } };
      if (parsed.error?.message) {
        reason = parsed.error.hint ? `${parsed.error.message} (${parsed.error.hint})` : parsed.error.message;
      }
    } catch {
      // stdout was not JSON; the stderr text above is the best there is.
    }
    if (/AUTH_REQUIRED|Not logged in/i.test(reason)) {
      throw new Error(
        `Circle CLI is not logged in for this environment: ${reason}. ` +
        'Testnet and mainnet are separate logins — `circle wallet login <email> --testnet` for Arc Testnet.',
      );
    }
    throw new Error(`Circle CLI failed: ${reason}`);
  }
}

/** The agent wallets Circle holds for this login on one chain. */
export async function listArcAgentWallets(chain: ArcCliChain = ARC_CLI_CHAINS.testnet): Promise<string[]> {
  const answer = (await circle(['wallet', 'list', '--chain', chain, '--type', 'agent'])) as {
    data?: { wallets?: Array<{ address?: string }> };
  };
  return (answer.data?.wallets ?? []).map((w) => String(w.address)).filter(Boolean);
}

/** Create one. Circle caps an account at five. */
export async function createArcAgentWallet(): Promise<string> {
  const answer = (await circle(['wallet', 'create'])) as { data?: { wallet?: { address?: string } } };
  const address = answer.data?.wallet?.address;
  if (!address) throw new Error('Circle CLI created a wallet but reported no address.');
  return address;
}

/** The address that actually signs for an agent wallet, per Circle. */
async function backingEoa(wallet: string, chain: ArcCliChain): Promise<`0x${string}`> {
  const answer = (await circle(['gateway', 'balance', '--address', wallet, '--chain', chain])) as {
    data?: { backingEOA?: string };
  };
  const backer = answer.data?.backingEOA;
  if (!backer) {
    throw new Error(
      `Circle did not say which address signs for agent wallet ${wallet}. ` +
      'Gateway holds the balance under that address, so paying without it would sign as nobody.',
    );
  }
  return backer as `0x${string}`;
}

/**
 * A payment wallet backed by an Arc agent wallet.
 *
 * `address` may be omitted, in which case the single agent wallet on that chain
 * is used — and having none, or several, is an error rather than a guess:
 * paying from a wallet the caller did not name spends somebody's money
 * somewhere they did not choose.
 */
export async function walletFromArcAgent(opts: {
  address?: string;
  chain?: ArcCliChain;
} = {}): Promise<PaymentWallet> {
  const chain = opts.chain ?? ARC_CLI_CHAINS.testnet;

  let address = opts.address;
  if (!address) {
    const wallets = await listArcAgentWallets(chain);
    if (wallets.length === 0) {
      throw new Error(
        `No Arc agent wallet exists on ${chain}. Create one with \`circle wallet create\`, ` +
        'or pass the address of one that does.',
      );
    }
    if (wallets.length > 1) {
      throw new Error(
        `${wallets.length} agent wallets exist on ${chain} (${wallets.join(', ')}). ` +
        'Name the one to pay from — picking for you would spend from a wallet nobody chose.',
      );
    }
    address = wallets[0];
  }

  // Circle uses the smart wallet for direct USDC authorizations (ERC-1271),
  // but its backing EOA owns the Gateway deposit. Signing always goes through
  // the same Circle agent wallet; signPayment chooses the authorization owner
  // for the selected offer without changing this wallet's identity.
  const signer = await backingEoa(address, chain);

  return {
    address: address as `0x${string}`,
    gatewayAddress: signer,
    signTypedData: async (message) => {
      // EIP-712 amounts arrive as BigInt and `JSON.stringify` refuses them
      // outright — "Do not know how to serialize a BigInt". They go over as
      // decimal strings, which is what EIP-712 encoders take for a uint256
      // anyway, so nothing is lost and nothing is rounded.
      // `EIP712Domain` spelled out.
      //
      // viem infers it from the domain's own fields and most libraries follow,
      // but Circle's CLI validates the typed data strictly and refuses a
      // request whose `types` does not declare it: "there is extra data
      // provided in the message (0 < 4)". Declared here to match the domain
      // actually given, field for field.
      const typed = message as { domain?: Record<string, unknown>; types?: Record<string, unknown> };
      const domainFields = [
        ['name', 'string'],
        ['version', 'string'],
        ['chainId', 'uint256'],
        ['verifyingContract', 'address'],
      ].filter(([field]) => typed.domain && typed.domain[field] !== undefined)
        .map(([name, type]) => ({ name, type }));

      const asJson = JSON.stringify(
        { ...typed, types: { EIP712Domain: domainFields, ...(typed.types ?? {}) } },
        (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      );
      if (process.env.ARC_WALLET_DEBUG) console.error('[arc-wallet] 서명 요청 =', asJson);
      const answer = (await circle([
        'wallet', 'sign', 'typed-data', asJson,
        '--address', address!, '--chain', chain,
      ])) as { data?: { signature?: string } };
      const signature = answer.data?.signature;
      if (!signature) throw new Error('Circle CLI signed nothing: no signature in its answer.');
      return signature as `0x${string}`;
    },
    describe: () => `Arc agent wallet ${address} on ${chain}, Gateway depositor ${signer}`,
  };
}
