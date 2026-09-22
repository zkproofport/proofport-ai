/** Published stdio MCP: CDP-paid all-in-one proof and unpaid step-flow refusal.
 * No wallet creation/funding. Requires the existing CDP wallet and credentials,
 * ATTESTATION_KEY, and the isolated published runner (E2E_MCP_ENTRY/SDK_ENTRY).
 * prepare_inputs witnesses stay in this trusted process and are never logged.
 */
import { CdpClient } from '@coinbase/cdp-sdk';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { paymentOffers, verifyProof } from '@zkproofport-ai/sdk';

const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:4002';
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Published MCP step-flow E2E requires ${name}; configure the existing fixture before running`);
  return value;
}
function parseResult(result: Awaited<ReturnType<Client['callTool']>>, operation: string, allowError = false) {
  // Never interpolate tool content: prepare_inputs contains private witness data.
  if (!allowError && result.isError) throw new Error(`${operation} failed; tool response withheld to protect private inputs`);
  const text = (result.content as Array<{ text?: string }>).find(item => typeof item.text === 'string')?.text;
  if (!text) throw new Error(`${operation} did not return JSON text`);
  try { return JSON.parse(text); } catch { throw new Error(`${operation} returned invalid JSON; content withheld`); }
}
async function fixture() {
  required('E2E_PUBLISHED_SDK_ENTRY');
  const entry = required('E2E_MCP_ENTRY');
  const apiKeyId = required('CDP_API_KEY_ID');
  const apiKeySecret = required('CDP_API_KEY_SECRET');
  const walletSecret = required('CDP_WALLET_SECRET');
  const name = process.env.CDP_WALLET_NAME || 'zkproofport-payer';
  // The production adapter uses getOrCreateAccount. Read-only lookup first
  // ensures its named account already exists; this test must never create one.
  let payer: `0x${string}`;
  try {
    const cdp = new CdpClient({ apiKeyId, apiKeySecret, walletSecret });
    payer = (await cdp.evm.getAccount({ name })).address;
  } catch { throw new Error('Existing named CDP payer lookup failed; no wallet creation attempted and provider details suppressed'); }
  if (process.env.CDP_WALLET_ADDRESS) expect(payer.toLowerCase()).toBe(process.env.CDP_WALLET_ADDRESS.toLowerCase());
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  Object.assign(env, { PROOFPORT_URL: baseUrl, ATTESTATION_KEY: required('ATTESTATION_KEY'), CDP_WALLET_NAME: name, ZKPROOFPORT_SILENT: '1' });
  const client = new Client({ name: 'published-mcp-step-flow-e2e', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env }));
    const challenge = parseResult(await client.callTool({ name: 'request_challenge', arguments: { circuit: 'coinbase_kyc', inputs: {} } }), 'request_challenge');
    expect(challenge.requiresPayment, 'This suite must exercise a paid deployment').toBe(true);
    expect(challenge.teePublicKey, 'This plaintext step-flow fixture targets GCP local mode').toBeFalsy();
    const offer = paymentOffers(challenge).find(item => item.networkName === 'base-sepolia');
    expect(offer, 'Staging must offer CDP payment on Base Sepolia').toBeDefined();
    expect(offer!.network).toBe('eip155:84532');
    const rpc = createPublicClient({ transport: http('https://sepolia.base.org') });
    expect(await rpc.getChainId()).toBe(84532);
    const balance = () => rpc.readContract({ address: offer!.asset as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [payer] });
    return { client, challenge, offer: offer!, balance };
  } catch (error) { await client.close(); throw error; }
}

describe.sequential('published MCP CDP payment and step-flow boundary', () => {
  it('generate_proof pays from the existing CDP wallet and both SDK and MCP verify on chain', { timeout: 240_000, retry: 0 }, async () => {
    const { client, offer, balance } = await fixture();
    try {
      const before = await balance();
      const price = BigInt(offer.amount);
      expect(price > 0n).toBe(true);
      expect(before >= price, 'Existing CDP payer needs Base Sepolia USDC before this test').toBe(true);
      const terms = offer.raw.extra as Record<string, unknown>;
      const result = parseResult(await client.callTool({ name: 'generate_proof', arguments: {
        circuit: 'coinbase_kyc', scope: 'e2e:mcp:cdp-paid', pay_with: 'cdp', pay_on: 'base-sepolia', max_payment: formatUnits(price, 6),
        approved_payment: { network: offer.network, scheme: offer.raw.scheme, amount: offer.amount, asset: offer.asset, payTo: offer.payTo,
          extra: { name: terms.name, version: terms.version, verifyingContract: offer.asset } },
      } }, undefined, { timeout: 180_000 }), 'generate_proof');
      expect(typeof result.proof === 'string' && /^0x[0-9a-f]+$/i.test(result.proof)).toBe(true);
      expect(before - await balance(), 'The existing CDP payer must be charged exactly the quoted USDC amount').toBe(price);
      const sdkVerification = await verifyProof(result);
      expect(sdkVerification.valid, 'SDK on-chain verification failed').toBe(true);
      const mcpVerification = parseResult(await client.callTool({ name: 'verify_proof', arguments: { result } }, undefined, { timeout: 60_000 }), 'verify_proof');
      expect(mcpVerification.valid, 'MCP on-chain verification failed').toBe(true);
    } finally { await client.close(); }
  });

  it('prepare_inputs → request_challenge → submit_proof refuses unpaid submission without charging the configured CDP wallet', { timeout: 150_000, retry: 0 }, async () => {
    const { client, balance } = await fixture();
    try {
      const tools = await client.listTools();
      const challengeTool = tools.tools.find(tool => tool.name === 'request_challenge');
      expect(challengeTool?.description).toMatch(/does not sign payments/i);
      expect(challengeTool?.description).toContain('generate_proof');
      const before = await balance();
      const prepared = parseResult(await client.callTool({ name: 'prepare_inputs', arguments: {
        circuit: 'coinbase_kyc', scope: 'e2e:mcp:unpaid-step-flow',
      } }, undefined, { timeout: 90_000 }), 'prepare_inputs');
      expect(Object.keys(prepared).length > 0).toBe(true);
      const challenge = parseResult(await client.callTool({ name: 'request_challenge', arguments: { circuit: 'coinbase_kyc', inputs: {} } }), 'request_challenge');
      expect(challenge.requiresPayment).toBe(true);
      expect(typeof challenge.nonce === 'string' && challenge.nonce.length > 0).toBe(true);
      const response = await client.callTool({ name: 'submit_proof', arguments: {
        circuit: 'coinbase_kyc', inputs: prepared, nonce: challenge.nonce,
      } }, undefined, { timeout: 30_000 });
      expect(response.isError, 'A nonce alone must never authorize paid proof generation').toBe(true);
      const rejection = parseResult(response, 'submit_proof', true);
      expect(typeof rejection.error === 'string' && rejection.error.startsWith('Proof generation failed: ')).toBe(true);
      const detail = JSON.parse(rejection.error.slice('Proof generation failed: '.length));
      expect(detail.error).toBe('PAYMENT_INVALID');
      expect(detail.reason).toBe('no_payment');
      expect(Boolean(detail.proof || detail.paymentTxHash)).toBe(false);
      expect(await balance(), 'Unpaid submit_proof must not debit the available CDP wallet').toBe(before);
    } finally { await client.close(); }
  });
});
