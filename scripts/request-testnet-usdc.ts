#!/usr/bin/env npx tsx
/** Fund an explicitly supplied existing test wallet; never create wallets. */
import { Contract, FetchRequest, JsonRpcProvider, ZeroAddress, getAddress, formatUnits, parseUnits } from 'ethers';
import { pathToFileURL } from 'node:url';
import { getPaymentNetwork } from '../src/payment/networks.js';

type FaucetNetwork = 'base-sepolia' | 'ethereum-sepolia';
type Credentials = { apiKeyId?: string; apiKeySecret?: string };
type FundingOptions = { network: string; address: string; minimumUsdc?: string; credentials?: Credentials };
type FundingDependencies = {
  balanceOf(network: FaucetNetwork, address: string): Promise<bigint>;
  requestFaucet(request: { network: FaucetNetwork; address: string; token: 'usdc' }, credentials: Required<Credentials>): Promise<{ transactionHash: string }>;
};

const liveDependencies: FundingDependencies = {
  async balanceOf(network, address) {
    const chain = getPaymentNetwork(network)!;
    const request = new FetchRequest(chain.defaultRpc);
    request.timeout = 15_000;
    const provider = new JsonRpcProvider(request);
    try {
      if ((await provider.getNetwork()).chainId !== BigInt(chain.chainId)) throw new Error('Wrong RPC chain');
      return await new Contract(chain.usdc, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(address) as bigint;
    } finally { provider.destroy(); }
  },
  async requestFaucet(request, credentials) {
    const { CdpClient } = await import('@coinbase/cdp-sdk');
    const client = new CdpClient(credentials);
    // CDP funds the supplied address. No wallet creation/signing API is used.
    return client.evm.requestFaucet(request);
  },
};

export async function ensureTestnetUsdc(options: FundingOptions, dependencies = liveDependencies) {
  if (options.network !== 'base-sepolia' && options.network !== 'ethereum-sepolia') {
    throw new Error('Network must be base-sepolia or ethereum-sepolia; mainnet is not supported');
  }
  const network = options.network;
  let address: string;
  try {
    address = getAddress(options.address);
    if (address === ZeroAddress) throw new Error();
  } catch { throw new Error('An existing nonzero wallet address is required'); }
  let minimum: bigint;
  try {
    minimum = parseUnits(options.minimumUsdc ?? '0.01', 6);
    if (minimum <= 0n) throw new Error();
  } catch { throw new Error('USDC minimum must be positive with at most six decimal places'); }
  const context = { network, address, token: 'usdc', minimumUsdc: formatUnits(minimum, 6) };
  let balance: bigint;
  try { balance = await dependencies.balanceOf(network, address); }
  catch { return { ...context, status: 'balance_unavailable', message: 'Could not verify the testnet USDC balance; no faucet request made.' }; }
  const current = { ...context, balanceUsdc: formatUnits(balance, 6) };
  if (balance >= minimum) return { ...current, status: 'adequate', message: 'Existing USDC balance meets the minimum; no faucet request made.' };
  const { apiKeyId, apiKeySecret } = options.credentials ?? {};
  if (!apiKeyId || !apiKeySecret) return { ...current, status: 'missing_credentials', message: 'Set CDP_API_KEY_ID and CDP_API_KEY_SECRET; no faucet request made.' };
  try {
    const result = await dependencies.requestFaucet({ network, address, token: 'usdc' }, { apiKeyId, apiKeySecret });
    if (!/^0x[0-9a-fA-F]{64}$/.test(result.transactionHash)) throw new Error('Invalid faucet transaction hash');
    return { ...current, status: 'requested', transactionHash: result.transactionHash, message: 'Faucet request submitted. Wait for confirmation, then rerun to check balance before E2E.' };
  } catch (error) {
    // Never print SDK errors: request details can contain authentication secrets.
    const status = (error as { status?: number; statusCode?: number })?.status
      ?? (error as { statusCode?: number })?.statusCode;
    if (status === 429) return { ...current, status: 'rate_limited', message: 'CDP faucet rate limit reached. Wait before retrying; no automatic retry was made.' };
    return { ...current, status: 'faucet_failed', message: 'CDP faucet request failed. Check credentials and faucet availability; provider error details are suppressed.' };
  }
}

const usage = 'Usage: npx tsx scripts/request-testnet-usdc.ts --network <base-sepolia|ethereum-sepolia> --address <existing-wallet> [--min-usdc 0.01]';
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--network', '--address', '--min-usdc'].includes(args[i]) || !args[i + 1] || values.has(args[i])) {
      console.error(usage); process.exitCode = 1; return;
    }
    values.set(args[i], args[i + 1]);
  }
  if (!values.has('--network') || !values.has('--address')) { console.error(usage); process.exitCode = 1; return; }
  const result = await ensureTestnetUsdc({
    network: values.get('--network')!, address: values.get('--address')!, minimumUsdc: values.get('--min-usdc'),
    credentials: { apiKeyId: process.env.CDP_API_KEY_ID, apiKeySecret: process.env.CDP_API_KEY_SECRET },
  });
  console.log(JSON.stringify(result));
  if (!['adequate', 'requested'].includes(result.status)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Testnet funding failed. Check the explicit network, address and minimum; no sensitive error details are printed.'); process.exitCode = 1; });
}
