/**
 * coinbase_country_attestation v2 against a real server (local container or
 * staging), through the SDK and through the stdio MCP, with and without an
 * EIP-712 action.
 *
 * What the server must do for this circuit, and what this suite checks:
 *   - read the wallet's Coinbase Verified Country attestation on chain,
 *     require the request's attestCountry transaction to name the same
 *     country, sign the 227-byte revocation statement with the key the
 *     circuit pins, and prove with it (signer kind = server);
 *   - the proof carries 215 public inputs: signal_hash 0-31,
 *     domain_separator 32-63, action_hash 64-95, signer root 96-127, country
 *     list 128-147, list length 148, is_included 149, scope 150-181,
 *     nullifier 182-213 (wallet + circuit-tag rule, the same with or without
 *     an action), attested_at 214 (fresh);
 *   - every proof verifies through the SDK's verifyProof (core's pinned
 *     verifier, on chain), and directly on the pinned Base Sepolia verifier;
 *     the same proof with attested_at changed does not;
 *   - refusals before payment: the KYC tag's nullifier, another wallet's
 *     attestCountry transaction, a country list the circuit cannot take.
 *
 * Needs ATTESTATION_KEY (the Coinbase-attested E2E wallet; its Country
 * attestation is KR) and, when the server charges, E2E_PAYER_WALLET_KEY.
 * scripts/run-published-e2e.mjs runs it with the registry SDK and MCP.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers, TypedDataEncoder } from 'ethers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as sdk from '@zkproofport-ai/sdk';
import { createConfig, fromPrivateKey, verifyProof, type ClientConfig, type ProofResult } from '@zkproofport-ai/sdk';
import { PINNED_VERIFIERS } from '@zkproofport-app/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPayment, type PayerPlan } from './payer.js';
import { callToolWithSimulatedApproval, generateProofWithSimulatedApproval } from './simulatedHumanApproval.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';
const ATTESTATION_KEY = process.env.ATTESTATION_KEY;
const PAYER_KEY = process.env.E2E_PAYER_WALLET_KEY;
const ID = 'coinbase_country_attestation';
const BASE_SEPOLIA_RPC = process.env.E2E_BASE_SEPOLIA_RPC_URL || 'https://base-sepolia.gateway.tenderly.co';
const VERIFIER_ABI = ['function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) view returns (bool)'];
const COUNTRY_LIST = ['US', 'KR'];

function fields(publicInputsHex: string): string[] {
  const hex = publicInputsHex.slice(2);
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += 64) out.push('0x' + hex.slice(i, i + 64));
  return out;
}
const bytesAt = (f: string[], start: number, n = 32) => ethers.hexlify(new Uint8Array(f.slice(start, start + n).map(x => Number(BigInt(x)))));

describe('coinbase_country_attestation v2 (server statement)', () => {
  let config: ClientConfig;
  let wallet: string;
  let plan: PayerPlan | undefined;
  let verifierAddress: string;

  beforeAll(async () => {
    if (!ATTESTATION_KEY) throw new Error('ATTESTATION_KEY required (the Coinbase-attested E2E wallet)');
    config = createConfig({ baseUrl: BASE_URL });
    wallet = await fromPrivateKey(ATTESTATION_KEY).getAddress();
    const pinned = PINNED_VERIFIERS[ID]?.[84532];
    if (!pinned) throw new Error(`core pins no ${ID} verifier on Base Sepolia (84532)`);
    verifierAddress = pinned.address;
    const challenge = await sdk.requestChallenge(config, 'coinbase_country');
    if (challenge.requiresPayment !== false) {
      if (!PAYER_KEY) throw new Error(`${BASE_URL} charges; E2E_PAYER_WALLET_KEY is required`);
      plan = await planPayment(config, 'coinbase_country', PAYER_KEY);
    }
  });

  const action = {
    domain: { name: 'E2E Country action', version: '1', chainId: 84532, verifyingContract: '0x1111111111111111111111111111111111111111' },
    types: { Grant: [{ name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'string' }] },
    primaryType: 'Grant', message: { amount: '1', nonce: 'country-v2' },
  };

  /** Checks every proof must pass; returns the nullifier. */
  async function judge(result: ProofResult, scope: string, before: number, bound: boolean): Promise<string> {
    const after = Math.floor(Date.now() / 1000);
    const f = fields(result.publicInputs);
    expect(f.length).toBe(215);
    const zero = ethers.ZeroHash;
    if (bound) {
      expect(bytesAt(f, 0)).toBe(zero);
      expect(bytesAt(f, 32)).toBe(TypedDataEncoder.hashDomain(action.domain).toLowerCase());
      expect(bytesAt(f, 64)).toBe(TypedDataEncoder.from(action.types).hash(action.message).toLowerCase());
    } else {
      expect(bytesAt(f, 0)).not.toBe(zero);
      expect(bytesAt(f, 32)).toBe(zero);
      expect(bytesAt(f, 64)).toBe(zero);
    }
    expect(bytesAt(f, 128, 4)).toBe(ethers.hexlify(ethers.toUtf8Bytes(COUNTRY_LIST.join(''))));
    expect(Number(BigInt(f[148]))).toBe(COUNTRY_LIST.length);
    expect(BigInt(f[149])).toBe(1n);
    const scopeBytes = ethers.keccak256(ethers.toUtf8Bytes(scope));
    expect(bytesAt(f, 150)).toBe(scopeBytes);
    const tag = ethers.keccak256(ethers.toUtf8Bytes(ID));
    const nullifier = ethers.keccak256(ethers.concat([ethers.keccak256(ethers.concat([wallet, tag])), scopeBytes]));
    expect(bytesAt(f, 182)).toBe(nullifier);
    const attestedAt = Number(BigInt(f[214]));
    expect(attestedAt).toBeGreaterThanOrEqual(before - 5);
    expect(attestedAt).toBeLessThanOrEqual(after + 5);

    const verified = await verifyProof(result);
    expect(verified.valid, verified.error).toBe(true);

    const verifier = new ethers.Contract(verifierAddress, VERIFIER_ABI, new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC, 84532, { staticNetwork: true }));
    expect(await verifier.verify(result.proof, f)).toBe(true);
    const tampered = [...f];
    tampered[214] = ethers.toBeHex(BigInt(f[214]) + 1n, 32);
    expect(await verifier.verify(result.proof, tampered).catch(() => false)).toBe(false);
    return nullifier;
  }

  it('SDK: with and without an action, both verify on chain and keep one nullifier', async () => {
    const scope = `e2e:country-v2:sdk:${Date.now()}`;
    const signers = { attestation: fromPrivateKey(ATTESTATION_KEY!), ...(plan && { payment: plan.wallet }) };
    const before = Math.floor(Date.now() / 1000);
    const plain = await sdk.generateProof(config, signers, { circuit: 'coinbase_country', scope, payOn: plan?.payOn, countryList: COUNTRY_LIST, isIncluded: true });
    const bound = await generateProofWithSimulatedApproval(sdk, config, signers, {
      circuit: 'coinbase_country', scope, payOn: plan?.payOn, countryList: COUNTRY_LIST, isIncluded: true, action,
    } as never);
    const n1 = await judge(plain, scope, before, false);
    const n2 = await judge(bound, scope, before, true);
    expect(n2).toBe(n1);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ e2e: 'coinbase_country_attestation_v2', via: 'sdk', baseUrl: BASE_URL, scope, verifier: verifierAddress, onChain: true }));
  }, 600_000);

  it('MCP: with and without an action, both verify on chain and keep one nullifier', async () => {
    const scope = `e2e:country-v2:mcp:${Date.now()}`;
    const approvalDirectory = await mkdtemp(join(tmpdir(), 'proofport-country-e2e-'));
    const entry = process.env.E2E_MCP_ENTRY;
    const transport = new StdioClientTransport({
      command: entry ? process.execPath : 'npx',
      args: entry ? [entry] : ['--no-install', 'zkproofport-mcp'],
      env: { ...process.env, PROOFPORT_URL: BASE_URL, ATTESTATION_KEY: ATTESTATION_KEY!, ...(PAYER_KEY && { PAYMENT_PRIVATE_KEY: PAYER_KEY, PAYMENT_KEY: PAYER_KEY }),
        ZKPROOFPORT_APPROVAL_DIR: approvalDirectory } as Record<string, string>,
    });
    const client = new Client({ name: 'country-v2-e2e', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const args = { circuit: 'coinbase_country', scope, country_list: COUNTRY_LIST, is_included: true, ...(plan && { pay_with: 'key', pay_on: plan.payOn }) };
      const before = Math.floor(Date.now() / 1000);
      const call = async (bound: boolean): Promise<ProofResult> => {
        const result = await callToolWithSimulatedApproval(client, config, fromPrivateKey(ATTESTATION_KEY!), 'generate_proof',
          bound ? { ...args, action } : args, 300_000) as { content: Array<{ text?: string }>; isError?: boolean };
        const text = result.content[0]?.text ?? '';
        expect(result.isError, `generate_proof failed: ${text}`).toBeFalsy();
        return JSON.parse(text);
      };
      const n1 = await judge(await call(false), scope, before, false);
      const n2 = await judge(await call(true), scope, before, true);
      expect(n2).toBe(n1);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ e2e: 'coinbase_country_attestation_v2', via: 'mcp', baseUrl: BASE_URL, scope, verifier: verifierAddress, onChain: true }));
    } finally {
      await client.close();
      await rm(approvalDirectory, { recursive: true, force: true });
    }
  }, 600_000);

  /** One REST /prove call with a payment nonce and these inputs; the server must refuse before charging. */
  async function proveWith(inputs: Record<string, unknown>) {
    const first = await fetch(`${BASE_URL}/api/v1/prove`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ circuit: 'coinbase_country' }) });
    expect(first.status).toBe(402);
    const { nonce } = await first.json();
    return fetch(`${BASE_URL}/api/v1/prove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Payment-Nonce': nonce },
      body: JSON.stringify({ circuit: 'coinbase_country', inputs }),
    });
  }
  const scopeBytes = ethers.keccak256(ethers.toUtf8Bytes('e2e:country-v2:refusal'));
  const nullifierFor = (who: string, id: string) =>
    ethers.keccak256(ethers.concat([ethers.keccak256(ethers.concat([who, ethers.keccak256(ethers.toUtf8Bytes(id))])), scopeBytes]));

  it("refuses the KYC tag's nullifier before payment", async () => {
    const res = await proveWith({ signal_hash: ethers.ZeroHash.replace(/0$/, '1'), nullifier: nullifierFor(wallet, 'coinbase_attestation'), scope_bytes: scopeBytes, user_address: wallet, merkle_root: ethers.ZeroHash, country_list: COUNTRY_LIST, is_included: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('NULLIFIER_RULE');
  });

  it("refuses another wallet's attestCountry transaction before payment", async () => {
    const stranger = ethers.Wallet.createRandom().address;
    const prepared = await sdk.prepareInputs(config, {
      circuitId: ID, userAddress: wallet, userSignature: await fromPrivateKey(ATTESTATION_KEY!).signMessage(sdk.computeSignalHash(wallet, 'e2e:country-v2:refusal', ID)),
      scope: 'e2e:country-v2:refusal', countryList: COUNTRY_LIST, isIncluded: true,
    }) as Record<string, unknown>;
    // The E2E wallet's real transaction, claimed for a stranger with the
    // stranger's own (rule-correct) nullifier: refused on the calldata wallet.
    const res = await proveWith({ ...prepared, user_address: stranger, nullifier: nullifierFor(stranger, ID) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('INVALID_REQUEST');
    expect(body.message).toMatch(/attests another wallet/);
  });

  it.each([['lowercase', ['kr']], ['11 codes', Array(11).fill('US')]])('refuses a country list with %s before payment', async (_name, list) => {
    const res = await proveWith({ signal_hash: ethers.ZeroHash.replace(/0$/, '1'), nullifier: nullifierFor(wallet, ID), scope_bytes: scopeBytes, user_address: wallet, merkle_root: ethers.ZeroHash, country_list: list, is_included: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('INVALID_REQUEST');
  });
});
