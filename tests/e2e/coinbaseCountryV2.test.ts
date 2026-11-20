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
 *   - the proof carries core's COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT:
 *     signal_hash, domain_separator, action_hash, signer root, the country
 *     list, its length, is_included, then the OPRF key hash, domain, scope
 *     and nullifier (one field each; the nullifier the same with or without
 *     an action), then attested_at (fresh);
 *   - every proof verifies through the SDK's verifyProof (core's pinned
 *     verifier, on chain), and directly on the pinned Base Sepolia verifier;
 *     the same proof with attested_at changed does not;
 *   - refusals before payment: a pre-OPRF request (no OPRF values), another
 *     wallet's attestCountry transaction, a country list the circuit cannot
 *     take.
 *
 * Needs ATTESTATION_KEY (the Coinbase-attested E2E wallet; its Country
 * attestation is KR), the server's OPRF network reachable, and, when the server charges, E2E_PAYER_WALLET_KEY.
 * scripts/run-published-e2e.mjs runs it with the registry SDK and MCP.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers, TypedDataEncoder } from 'ethers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as sdk from '@zkproofport-ai/sdk';
import { createConfig, fromPrivateKey, verifyProof, type ClientConfig, type ProofResult } from '@zkproofport-ai/sdk';
import { PINNED_VERIFIERS, COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT as LAYOUT } from '@zkproofport-app/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPayment, type PayerPlan } from './payer.js';
import { callToolWithSimulatedApproval, generateProofWithSimulatedApproval } from './simulatedHumanApproval.js';
import { E2E_OPRF_DOMAIN, expectOprfPublicInputs, publicInputFields } from './oprf.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';
const ATTESTATION_KEY = process.env.ATTESTATION_KEY;
const PAYER_KEY = process.env.E2E_PAYER_WALLET_KEY;
const ID = 'coinbase_country_attestation';
const BASE_SEPOLIA_RPC = process.env.E2E_BASE_SEPOLIA_RPC_URL || 'https://base-sepolia.gateway.tenderly.co';
const VERIFIER_ABI = ['function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) view returns (bool)'];
const COUNTRY_LIST = ['US', 'KR'];

const bytesAt = (f: string[], start: number, n = 32) => ethers.hexlify(new Uint8Array(f.slice(start, start + n).map(x => Number(BigInt(x)))));

describe('coinbase_country_attestation v2 (server statement)', () => {
  let config: ClientConfig;
  let wallet: string;
  let plan: PayerPlan | undefined;
  let verifierAddress: string;
  let environment: sdk.OprfEnvironment;

  beforeAll(async () => {
    if (!ATTESTATION_KEY) throw new Error('ATTESTATION_KEY required (the Coinbase-attested E2E wallet)');
    config = createConfig({ baseUrl: BASE_URL });
    wallet = await fromPrivateKey(ATTESTATION_KEY).getAddress();
    const pinned = PINNED_VERIFIERS[ID]?.[84532];
    if (!pinned) throw new Error(`core pins no ${ID} verifier on Base Sepolia (84532)`);
    verifierAddress = pinned.address;
    environment = await sdk.fetchOprfEnvironment(config);
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
    const f = publicInputFields(result.publicInputs);
    expect(result.scope).toBe(scope);
    expect(result.oprfDomain).toBe(E2E_OPRF_DOMAIN);
    expect(result.oprfEnvironment).toBe(environment);
    const nullifier = expectOprfPublicInputs(f, ID, { scope, oprfDomain: E2E_OPRF_DOMAIN, environment });
    const zero = ethers.ZeroHash;
    if (bound) {
      expect(bytesAt(f, LAYOUT.SIGNAL_HASH_START)).toBe(zero);
      expect(bytesAt(f, LAYOUT.DOMAIN_SEPARATOR_START)).toBe(TypedDataEncoder.hashDomain(action.domain).toLowerCase());
      expect(bytesAt(f, LAYOUT.ACTION_HASH_START)).toBe(TypedDataEncoder.from(action.types).hash(action.message).toLowerCase());
    } else {
      expect(bytesAt(f, LAYOUT.SIGNAL_HASH_START)).not.toBe(zero);
      expect(bytesAt(f, LAYOUT.DOMAIN_SEPARATOR_START)).toBe(zero);
      expect(bytesAt(f, LAYOUT.ACTION_HASH_START)).toBe(zero);
    }
    expect(bytesAt(f, LAYOUT.COUNTRY_LIST_START, 2 * COUNTRY_LIST.length)).toBe(ethers.hexlify(ethers.toUtf8Bytes(COUNTRY_LIST.join(''))));
    expect(Number(BigInt(f[LAYOUT.COUNTRY_LIST_LENGTH]))).toBe(COUNTRY_LIST.length);
    expect(BigInt(f[LAYOUT.IS_INCLUDED])).toBe(1n);
    const attestedAt = Number(BigInt(f[LAYOUT.ATTESTED_AT]));
    expect(attestedAt).toBeGreaterThanOrEqual(before - 5);
    expect(attestedAt).toBeLessThanOrEqual(after + 5);

    const verified = await verifyProof(config, result, { request: { scope, requestId: result.requestId!, oprfDomain: E2E_OPRF_DOMAIN } });
    expect(verified.valid, verified.error).toBe(true);

    const verifier = new ethers.Contract(verifierAddress, VERIFIER_ABI, new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC, 84532, { staticNetwork: true }));
    expect(await verifier.verify(result.proof, f)).toBe(true);
    const tampered = [...f];
    tampered[LAYOUT.ATTESTED_AT] = ethers.toBeHex(BigInt(f[LAYOUT.ATTESTED_AT]) + 1n, 32);
    expect(await verifier.verify(result.proof, tampered).catch(() => false)).toBe(false);
    return nullifier;
  }

  it('SDK: with and without an action, both verify on chain and keep one nullifier', async () => {
    const scope = `e2e:country-v2:sdk:${Date.now()}`;
    const signers = { attestation: fromPrivateKey(ATTESTATION_KEY!), ...(plan && { payment: plan.wallet }) };
    const before = Math.floor(Date.now() / 1000);
    const plain = await sdk.generateProof(config, signers, { circuit: 'coinbase_country', scope, oprfDomain: E2E_OPRF_DOMAIN, payOn: plan?.payOn, countryList: COUNTRY_LIST, isIncluded: true });
    const bound = await generateProofWithSimulatedApproval(sdk, config, signers, {
      circuit: 'coinbase_country', scope, oprfDomain: E2E_OPRF_DOMAIN, payOn: plan?.payOn, countryList: COUNTRY_LIST, isIncluded: true, action,
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
      // Name the wallet whenever one is handed over, charged or not: .env.test
      // also carries a CDP credential, and with two configured the MCP refuses
      // to guess (as it should). Until 2026-11-11 this named it only when the
      // server charged, so every free local run failed here.
      const args = { circuit: 'coinbase_country', scope, oprf_domain: E2E_OPRF_DOMAIN, country_list: COUNTRY_LIST, is_included: true,
        ...(PAYER_KEY && { pay_with: 'key' }), ...(plan && { pay_on: plan.payOn }) };
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
  const REFUSAL_SCOPE = 'e2e:country-v2:refusal';
  /** One real OPRF evaluation for the E2E wallet, shared by the refusal cases (the server checks shape and key hash). */
  let refusalOprf: sdk.PreparedOprf | undefined;
  const oprfForRefusals = async () => (refusalOprf ??= await sdk.prepareOprf(config, { circuitId: ID, address: wallet, oprfDomain: E2E_OPRF_DOMAIN, scope: REFUSAL_SCOPE }));

  it('refuses a pre-OPRF request (keccak nullifier, scope_bytes, no OPRF values) before payment', async () => {
    const scopeBytes = ethers.keccak256(ethers.toUtf8Bytes(REFUSAL_SCOPE));
    const keccakNullifier = ethers.keccak256(ethers.concat([ethers.keccak256(ethers.concat([wallet, ethers.keccak256(ethers.toUtf8Bytes(ID))])), scopeBytes]));
    const res = await proveWith({ signal_hash: ethers.ZeroHash.replace(/0$/, '1'), nullifier: keccakNullifier, scope_bytes: scopeBytes, user_address: wallet, merkle_root: ethers.ZeroHash, country_list: COUNTRY_LIST, is_included: true });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('INVALID_REQUEST');
    expect(body.message).toMatch(/^oprf_key_hash must be 0x/);
  });

  it("refuses another wallet's attestCountry transaction before payment", async () => {
    const stranger = ethers.Wallet.createRandom().address;
    const requestId = sdk.newRequestId();
    const oprf = await oprfForRefusals();
    const prepared = await sdk.prepareInputs(config, {
      circuitId: ID, userAddress: wallet, userSignature: await fromPrivateKey(ATTESTATION_KEY!).signMessage(sdk.computeSignalHash({ scope: REFUSAL_SCOPE, circuitId: ID, requestId })),
      scope: REFUSAL_SCOPE, countryList: COUNTRY_LIST, isIncluded: true, requestId, oprf,
    }) as Record<string, unknown>;
    // The E2E wallet's real transaction (and its valid OPRF values), claimed
    // for a stranger: refused on the calldata wallet.
    const res = await proveWith({ ...prepared, user_address: stranger });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('INVALID_REQUEST');
    expect(body.message).toMatch(/attests another wallet/);
  });

  it.each([['lowercase', ['kr']], ['11 codes', Array(11).fill('US')]])('refuses a country list with %s before payment', async (_name, list) => {
    const oprf = await oprfForRefusals();
    const res = await proveWith({ signal_hash: ethers.ZeroHash.replace(/0$/, '1'), user_address: wallet, merkle_root: ethers.ZeroHash, ...oprf.inputs, country_list: list, is_included: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('INVALID_REQUEST');
  });
});
