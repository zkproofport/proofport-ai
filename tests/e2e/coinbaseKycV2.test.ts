/**
 * coinbase_attestation v2 against a real server (local container or staging).
 *
 * What the server must do for this circuit, and what this suite checks over HTTP:
 *   - read the wallet's Coinbase KYC attestation on chain, sign the 225-byte
 *     revocation statement with the Cloud KMS key the circuit pins, and prove
 *     with it (signer kind = server);
 *   - the proof carries core's COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT: the
 *     OPRF key hash, domain, scope and nullifier as one field each, then
 *     attested_at. The four OPRF values are exactly the ones the SDK's OPRF
 *     evaluation produced for this wallet, (oprfDomain, scope);
 *   - the proof verifies on the v2 verifier on Base Sepolia, and a proof with
 *     one public input changed does not;
 *   - refusals happen before any payment: a pre-OPRF request (keccak
 *     nullifier, no OPRF values), an OPRF answer under another key, a value
 *     at the field modulus, and a wallet with no Coinbase attestation.
 *
 * The proof is requested through the SDK's step functions (prepareOprf,
 * prepareInputs, requestChallenge, signPayment, submitProof), so the suite
 * runs with the workspace SDK locally and with the registry SDK against a
 * deployment (scripts/run-published-e2e.mjs).
 *
 * On-chain verification calls the verifier contract directly, at an address
 * PINNED HERE from circuits' deployment record at the pinned commit
 * (broadcast/DeployCoinbaseAttestationV2.s.sol/84532, bb 6.0.0), not the one
 * the response names.
 *
 * Needs ATTESTATION_KEY (the Coinbase-attested E2E wallet), the server's
 * OPRF network reachable, and, when the server charges, E2E_PAYER_WALLET_KEY.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import * as sdk from '@zkproofport-ai/sdk';
import { createConfig, fromPrivateKey, type ClientConfig, type ProofportSigner, type PaymentWallet } from '@zkproofport-ai/sdk';
import { OPRF_FIELD_MODULUS, oprfLayoutOf, COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT as LAYOUT } from '@zkproofport-app/core';
import { planPayment } from './payer.js';
import { E2E_OPRF_DOMAIN, expectOprfPublicInputs, publicInputFields } from './oprf.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';
const ATTESTATION_KEY = process.env.ATTESTATION_KEY;
const PAYER_KEY = process.env.E2E_PAYER_WALLET_KEY;

const ID = 'coinbase_attestation';
const V2_VERIFIER_BASE_SEPOLIA = '0xe78fcdc7562ce3afceadaf29f4b8b96dc997c01a';
const BASE_SEPOLIA_RPC = process.env.E2E_BASE_SEPOLIA_RPC_URL || 'https://base-sepolia.gateway.tenderly.co';
const VERIFIER_ABI = ['function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) view returns (bool)'];

describe('coinbase_attestation v2 (server statement signed with Cloud KMS)', () => {
  let config: ClientConfig;
  let signer: ProofportSigner;
  let wallet: string;
  let payment: PaymentWallet | undefined;
  let payOn: string | undefined;
  let environment: sdk.OprfEnvironment;

  beforeAll(async () => {
    if (!ATTESTATION_KEY) throw new Error('ATTESTATION_KEY required (the Coinbase-attested E2E wallet)');
    config = createConfig({ baseUrl: BASE_URL });
    signer = fromPrivateKey(ATTESTATION_KEY);
    wallet = await signer.getAddress();
    environment = await sdk.fetchOprfEnvironment(config);
    const challenge = await sdk.requestChallenge(config, 'coinbase_kyc');
    if (challenge.requiresPayment !== false) {
      if (!PAYER_KEY) throw new Error(`${BASE_URL} charges; E2E_PAYER_WALLET_KEY is required`);
      const plan = await planPayment(config, 'coinbase_kyc', PAYER_KEY);
      payment = plan.wallet;
      payOn = plan.payOn;
    }
  });

  it('proves with the server statement; the proof verifies on the v2 verifier and a changed input does not', async () => {
    const scope = `e2e:coinbase-v2:${Date.now()}`;
    const before = Math.floor(Date.now() / 1000);
    const requestId = sdk.newRequestId();
    const oprf = await sdk.prepareOprf(config, { circuitId: ID, address: wallet, oprfDomain: E2E_OPRF_DOMAIN, scope });
    expect(oprf.environment).toBe(environment);
    const signalHash = sdk.computeSignalHash({ scope, circuitId: ID, requestId });
    const signature = await signer.signMessage(signalHash);
    const inputs = await sdk.prepareInputs(config, { circuitId: ID, userAddress: wallet, userSignature: signature, scope, requestId, oprf });
    const challenge = await sdk.requestChallenge(config, 'coinbase_kyc');
    const paid = challenge.requiresPayment
      ? await sdk.signPayment(challenge as never, payment!, { network: payOn })
      : undefined;
    const response = await sdk.submitProof(config, {
      circuit: 'coinbase_kyc',
      inputs: inputs as Record<string, unknown>,
      nonce: challenge.nonce,
      paymentHeaders: paid?.headers,
    });
    const result = response as unknown as { proof: string; publicInputs: string; verification?: { chainId?: number; verifierAddress?: string } };
    const after = Math.floor(Date.now() / 1000);

    const f = publicInputFields(result.publicInputs);
    const nullifier = expectOprfPublicInputs(f, ID, { scope, oprfDomain: E2E_OPRF_DOMAIN, environment });
    // The proof carries exactly the evaluation the SDK made and checked.
    const layout = oprfLayoutOf(ID);
    expect(f[layout.keyHash]).toBe(oprf.inputs.oprf_key_hash);
    expect(f[layout.domain]).toBe(oprf.inputs.domain);
    expect(f[layout.scope]).toBe(oprf.inputs.scope);
    expect(nullifier).toBe(oprf.inputs.nullifier);
    expect(f[LAYOUT.SIGNAL_HASH_START]).not.toBe(ethers.ZeroHash);
    const attestedAt = Number(BigInt(f[LAYOUT.ATTESTED_AT]));
    expect(attestedAt).toBeGreaterThanOrEqual(before - 5);
    expect(attestedAt).toBeLessThanOrEqual(after + 5);

    expect(result.verification?.chainId).toBe(84532);
    expect(result.verification?.verifierAddress?.toLowerCase()).toBe(V2_VERIFIER_BASE_SEPOLIA.toLowerCase());

    const verifier = new ethers.Contract(V2_VERIFIER_BASE_SEPOLIA, VERIFIER_ABI, new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC, 84532, { staticNetwork: true }));
    expect(await verifier.verify(result.proof, f)).toBe(true);
    const tampered = [...f];
    tampered[LAYOUT.ATTESTED_AT] = ethers.toBeHex(BigInt(f[LAYOUT.ATTESTED_AT]) + 1n, 32);
    const tamperedOk = await verifier.verify(result.proof, tampered).catch(() => false);
    expect(tamperedOk).toBe(false);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ e2e: 'coinbase_attestation_v2', baseUrl: BASE_URL, wallet, scope, oprfDomain: E2E_OPRF_DOMAIN, oprfEnvironment: environment, attestedAt, paidOn: paid?.paidOn ?? null, verifier: V2_VERIFIER_BASE_SEPOLIA, onChain: true, tamperedRejected: true, proofBytes: (result.proof.length - 2) / 2 }));
    if (process.env.E2E_V2_PROOF_OUT) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(process.env.E2E_V2_PROOF_OUT, JSON.stringify({ proof: result.proof, publicInputs: result.publicInputs, verification: result.verification, scope, wallet }));
    }
  }, 300_000);

  /** One REST /prove call with a payment nonce and these inputs; the server must refuse before charging. */
  async function proveWith(inputs: Record<string, unknown>) {
    const first = await fetch(`${BASE_URL}/api/v1/prove`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ circuit: 'coinbase_kyc' }) });
    expect(first.status).toBe(402);
    const { nonce } = await first.json();
    return fetch(`${BASE_URL}/api/v1/prove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Payment-Nonce': nonce },
      body: JSON.stringify({ circuit: 'coinbase_kyc', inputs }),
    });
  }

  /** One real OPRF evaluation for the E2E wallet, shared by the refusal cases (the server checks shape and key hash). */
  let refusalOprf: sdk.PreparedOprf | undefined;
  async function oprfFor(scope: string): Promise<Record<string, string>> {
    refusalOprf ??= await sdk.prepareOprf(config, { circuitId: ID, address: wallet, oprfDomain: E2E_OPRF_DOMAIN, scope });
    return { ...refusalOprf.inputs };
  }

  it('refuses a pre-OPRF request (keccak nullifier, scope_bytes, no OPRF values) before payment, naming the missing value', async () => {
    const scope = 'e2e:coinbase-v2:refusal';
    const signalHash = ethers.keccak256(ethers.solidityPacked(['address', 'string', 'string'], [wallet, scope, ID]));
    const scopeBytes = ethers.keccak256(ethers.toUtf8Bytes(scope));
    const v1 = ethers.keccak256(ethers.concat([ethers.keccak256(ethers.concat([wallet, signalHash])), scopeBytes]));
    const res = await proveWith({ signal_hash: signalHash, nullifier: v1, scope_bytes: scopeBytes, user_address: wallet, merkle_root: ethers.ZeroHash });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('INVALID_REQUEST');
    expect(body.message).toMatch(/^oprf_key_hash must be 0x/);
  });

  it('refuses an OPRF answer under a key other than the pinned one before payment', async () => {
    const oprf = await oprfFor('e2e:coinbase-v2:refusal');
    const other = '0x' + (BigInt(oprf.oprf_key_hash) ^ 1n).toString(16).padStart(64, '0');
    const res = await proveWith({ signal_hash: ethers.ZeroHash.replace(/0$/, '1'), user_address: wallet, merkle_root: ethers.ZeroHash, ...oprf, oprf_key_hash: other });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('OPRF_KEY_HASH_MISMATCH');
    expect(body.message).toContain(`'${environment}'`);
  });

  it('refuses a nullifier at the field modulus before payment (never reduced)', async () => {
    const oprf = await oprfFor('e2e:coinbase-v2:refusal');
    const res = await proveWith({ signal_hash: ethers.ZeroHash.replace(/0$/, '1'), user_address: wallet, merkle_root: ethers.ZeroHash, ...oprf, nullifier: ethers.toBeHex(OPRF_FIELD_MODULUS, 32) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('INVALID_REQUEST');
    expect(body.message).toMatch(/^nullifier is not below the field modulus p/);
  });

  it('refuses a wallet with no Coinbase attestation before payment', async () => {
    const stranger = ethers.Wallet.createRandom().address;
    const oprf = await oprfFor('e2e:coinbase-v2:refusal');
    const res = await proveWith({ signal_hash: ethers.ZeroHash.replace(/0$/, '1'), user_address: stranger, merkle_root: ethers.ZeroHash, ...oprf });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('NO_COINBASE_ATTESTATION');
  });
});
