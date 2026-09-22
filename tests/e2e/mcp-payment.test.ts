/** Real published MCP payments: four staging networks, one proof per network.
 * Requires ATTESTATION_KEY, existing funded E2E_PAYER_WALLET_KEY (or explicit
 * E2E_PAYER_KEY_BASE_SEPOLIA / E2E_PAYER_KEY_ETHEREUM_SEPOLIA overrides), and
 * E2E_ARC_AGENT_ADDRESS plus the existing Circle CLI login. Never creates or
 * funds wallets, and never retries a paid proof. Circle developer-controlled
 * wallets are a separate adapter and are not covered by these agent-wallet cases.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPublicClient, erc20Abi, formatUnits, http, parseUnits } from 'viem';
import { createConfig, paymentOffers, requestChallenge, verifyProof, walletFromPrivateKey } from '@zkproofport-ai/sdk';

const run = promisify(execFile);
const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:4002';
const rows = [
  { network: 'base-sepolia', chainId: 84532, payWith: 'key', rpc: process.env.CHAIN_RPC_URL || 'https://sepolia.base.org' },
  { network: 'ethereum-sepolia', chainId: 11155111, payWith: 'key', rpc: process.env.ETHEREUM_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com' },
  { network: 'arc-testnet', chainId: 5042002, payWith: 'arc', rpc: process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.io' },
  { network: 'arc-testnet-nano', chainId: 5042002, payWith: 'arc', rpc: process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.io' },
] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MCP payment E2E requires ${name}; configure the existing wallet before this paid test`);
  return value;
}

async function agentGatewayBalance(address: string): Promise<bigint> {
  const { stdout } = await run('circle', ['gateway', 'balance', '--address', address, '--chain', 'ARC-TESTNET', '--output', 'json'], {
    env: { ...process.env, CIRCLE_ACCEPT_TERMS: '1' }, timeout: 30_000,
  });
  const value = JSON.parse(stdout).data?.total;
  if (typeof value !== 'string' || !/^\d+(\.\d{1,6})?$/.test(value)) {
    throw new Error('Circle CLI did not report a valid existing Gateway USDC balance');
  }
  return parseUnits(value, 6);
}

function toolData(result: Awaited<ReturnType<Client['callTool']>>, operation: string) {
  const text = (result.content as Array<{ text?: string }>).find(item => item.text)?.text;
  expect(result.isError, result.isError ? `${operation}: ${text}` : operation).not.toBe(true);
  expect(text, `${operation} must return JSON`).toBeTruthy();
  return JSON.parse(text!);
}

describe.sequential('published MCP: each staging payment network', () => {
  for (const row of rows) it(`${row.network}: ${row.payWith} pays exactly the quoted fee and the proof verifies`, { timeout: 240_000, retry: 0 }, async () => {
    const credential = requireEnv('ATTESTATION_KEY');
    const keyName = `E2E_PAYER_KEY_${row.network.toUpperCase().replace(/-/g, '_')}`;
    const key = row.payWith === 'key'
      ? (process.env[keyName] || process.env.PAYMENT_PRIVATE_KEY || requireEnv('E2E_PAYER_WALLET_KEY'))
      : undefined;
    const payer = row.payWith === 'arc' ? requireEnv('E2E_ARC_AGENT_ADDRESS') : (await walletFromPrivateKey(key!)).address;
    const challenge = await requestChallenge(createConfig({ baseUrl }), 'coinbase_kyc');
    expect(challenge.requiresPayment, 'MCP payment tests require an actively charging deployment').toBe(true);
    const offer = paymentOffers(challenge).find(item => item.networkName === row.network);
    expect(offer, `Required staging offer ${row.network} is missing`).toBeDefined();
    expect(offer!.network).toBe(`eip155:${row.chainId}`);
    const terms = offer!.raw.extra as Record<string, unknown>;
    expect(typeof terms.name).toBe('string');
    expect(typeof terms.version).toBe('string');
    const signingContract = row.network === 'arc-testnet-nano' ? terms.verifyingContract : offer!.asset;
    expect(signingContract).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const approvedPayment = {
      network: offer!.network, scheme: offer!.raw.scheme, amount: offer!.amount,
      asset: offer!.asset, payTo: offer!.payTo,
      extra: { name: terms.name, version: terms.version, verifyingContract: signingContract },
    };
    const price = BigInt(offer!.amount);
    expect(price).toBeGreaterThan(0n);
    const rpc = createPublicClient({ transport: http(row.rpc) });
    expect(await rpc.getChainId(), `RPC for ${row.network} must be the intended payment chain`).toBe(row.chainId);
    const balance = row.network === 'arc-testnet-nano'
      ? () => agentGatewayBalance(payer)
      : () => rpc.readContract({ address: offer!.asset as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [payer as `0x${string}`] });
    const before = await balance();
    expect(before >= price, `Fund existing ${payer} on ${row.network}; balance ${before}, quote ${price} atomic USDC`).toBe(true);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    Object.assign(env, { PROOFPORT_URL: baseUrl, ATTESTATION_KEY: credential, ZKPROOFPORT_SILENT: '1' });
    if (row.payWith === 'key') env.PAYMENT_PRIVATE_KEY = key!;
    else Object.assign(env, { ARC_AGENT_WALLET: payer, ARC_CLI_CHAIN: 'ARC-TESTNET' });
    const entry = process.env.E2E_MCP_ENTRY;
    const client = new Client({ name: 'mcp-payment-matrix', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(new StdioClientTransport({ command: entry ? process.execPath : 'npx', args: entry ? [entry] : ['--no-install', 'zkproofport-mcp'], env }));
      const result = toolData(await client.callTool({ name: 'generate_proof', arguments: {
        circuit: 'coinbase_kyc', scope: `e2e:mcp:payment:${row.network}`, pay_with: row.payWith,
        pay_on: row.network, max_payment: formatUnits(price, 6), approved_payment: approvedPayment,
      } }, undefined, { timeout: 180_000 }), 'generate_proof');
      expect(result.circuit).toBe('coinbase_attestation');
      expect(result.proof).toMatch(/^0x[0-9a-f]+$/i);
      // Independent observations: actual payer debit, SDK RPC verification,
      // and the published MCP verify_proof tool all have to agree.
      const after = await balance();
      expect(before - after, `Actual ${row.network} payer debit differs from its quoted fee`).toBe(price);
      const verified = await verifyProof(result);
      expect(verified.valid, verified.error).toBe(true);
      const mcpVerified = toolData(await client.callTool({ name: 'verify_proof', arguments: { result } }, undefined, { timeout: 60_000 }), 'verify_proof');
      expect(mcpVerified.valid, mcpVerified.error).toBe(true);
    } finally { await client.close(); }
  });
});
