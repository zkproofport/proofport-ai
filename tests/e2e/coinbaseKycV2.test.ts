/**
 * coinbase_attestation v2 against a real server (local container or staging).
 *
 * What the server must do for this circuit, and what this suite checks over HTTP:
 *   - read the wallet's Coinbase KYC attestation on chain, sign the 225-byte
 *     revocation statement with the Cloud KMS key the circuit pins, and prove
 *     with it (signer kind = server);
 *   - the proof carries 193 public inputs: giwa_attestation's six, then
 *     attested_at -- scope at 128..159, nullifier at 160..191, the nullifier
 *     by the wallet + circuit-tag rule;
 *   - the proof verifies on the v2 verifier on Base Sepolia, and a proof with
 *     one public input changed does not;
 *   - refusals happen before any payment: a v1 (signal-hash) nullifier, and a
 *     wallet with no Coinbase attestation.
 *
 * The proof is requested through the SDK's step functions (prepareInputs,
 * requestChallenge, signPayment, submitProof), so the suite runs with the
 * workspace SDK locally and with the registry SDK against a deployment
 * (scripts/run-published-e2e.mjs). An SDK released before v2 derives v1's
 * nullifier; the suite then replaces it with v2's wallet + circuit-tag rule
 * and SAYS so in its output -- the one thing the next SDK release changes.
 *
 * On-chain verification calls the verifier contract directly, at an address
 * PINNED HERE from circuits' deployment record (broadcast/
 * DeployCoinbaseAttestationV2.s.sol/84532), not the one the response names:
 * @zkproofport-app/core 0.4.0-beta.0 -- what the SDK's verifyProof uses -- still pins
 * v1 and refuses these proofs until core's v2 release.
 *
 * Needs ATTESTATION_KEY (the Coinbase-attested E2E wallet) and, when the
 * server charges, E2E_PAYER_WALLET_KEY.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import * as sdk from '@zkproofport-ai/sdk';
import { createConfig, fromPrivateKey, type ClientConfig, type ProofportSigner, type PaymentWallet } from '@zkproofport-ai/sdk';
import { planPayment } from './payer.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';
const ATTESTATION_KEY = process.env.ATTESTATION_KEY;
const PAYER_KEY = process.env.E2E_PAYER_WALLET_KEY;

const V2_VERIFIER_BASE_SEPOLIA = '0x1885aA2283DB21ad0fc63A2Df98efe92F31908E6';
const BASE_SEPOLIA_RPC = process.env.E2E_BASE_SEPOLIA_RPC_URL || 'https://base-sepolia.gateway.tenderly.co';
const VERIFIER_ABI = ['function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) view returns (bool)'];

function fields(publicInputsHex: string): string[] {
  const hex = publicInputsHex.slice(2);
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += 64) out.push('0x' + hex.slice(i, i + 64));
  return out;
}
const bytesAt = (f: string[], start: number) => ethers.hexlify(new Uint8Array(f.slice(start, start + 32).map(x => Number(BigInt(x)))));

describe('coinbase_attestation v2 (server statement signed with Cloud KMS)', () => {
  let config: ClientConfig;
  let signer: ProofportSigner;
  let wallet: string;
  let payment: PaymentWallet | undefined;
  let payOn: string | undefined;

  beforeAll(async () => {
    if (!ATTESTATION_KEY) throw new Error('ATTESTATION_KEY required (the Coinbase-attested E2E wallet)');
    config = createConfig({ baseUrl: BASE_URL });
    signer = fromPrivateKey(ATTESTATION_KEY);
    wallet = await signer.getAddress();
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
    const signalHash = sdk.computeSignalHash(wallet, scope, 'coinbase_attestation');
    const signature = await signer.signMessage(signalHash);
    const inputs = await sdk.prepareInputs(config, { circuitId: 'coinbase_attestation', userAddress: wallet, userSignature: signature, scope });
    const v2Nullifier = ethers.keccak256(ethers.concat([
      ethers.keccak256(ethers.concat([wallet, ethers.keccak256(ethers.toUtf8Bytes('coinbase_attestation'))])),
      ethers.keccak256(ethers.toUtf8Bytes(scope)),
    ]));
    const sdkNullifierRule = (inputs as { nullifier: string }).nullifier.toLowerCase() === v2Nullifier.toLowerCase() ? 'v2' : 'v1-replaced';
    const challenge = await sdk.requestChallenge(config, 'coinbase_kyc');
    const paid = challenge.requiresPayment
      ? await sdk.signPayment(challenge as never, payment!, { network: payOn })
      : undefined;
    const response = await sdk.submitProof(config, {
      circuit: 'coinbase_kyc',
      inputs: { ...(inputs as Record<string, unknown>), nullifier: v2Nullifier },
      nonce: challenge.nonce,
      paymentHeaders: paid?.headers,
    });
    const result = response as unknown as { proof: string; publicInputs: string; verification?: { chainId?: number; verifierAddress?: string } };
    const after = Math.floor(Date.now() / 1000);

    const f = fields(result.publicInputs);
    expect(f.length).toBe(193);
    const scopeBytes = ethers.keccak256(ethers.toUtf8Bytes(scope));
    expect(bytesAt(f, 128)).toBe(scopeBytes);
    const tag = ethers.keccak256(ethers.toUtf8Bytes('coinbase_attestation'));
    const nullifier = ethers.keccak256(ethers.concat([ethers.keccak256(ethers.concat([wallet, tag])), scopeBytes]));
    expect(bytesAt(f, 160)).toBe(nullifier);
    const attestedAt = Number(BigInt(f[192]));
    expect(attestedAt).toBeGreaterThanOrEqual(before - 5);
    expect(attestedAt).toBeLessThanOrEqual(after + 5);

    expect(result.verification?.chainId).toBe(84532);
    expect(result.verification?.verifierAddress?.toLowerCase()).toBe(V2_VERIFIER_BASE_SEPOLIA.toLowerCase());

    const verifier = new ethers.Contract(V2_VERIFIER_BASE_SEPOLIA, VERIFIER_ABI, new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC, 84532, { staticNetwork: true }));
    expect(await verifier.verify(result.proof, f)).toBe(true);
    const tampered = [...f];
    tampered[192] = ethers.toBeHex(BigInt(f[192]) + 1n, 32);
    const tamperedOk = await verifier.verify(result.proof, tampered).catch(() => false);
    expect(tamperedOk).toBe(false);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ e2e: 'coinbase_attestation_v2', baseUrl: BASE_URL, wallet, scope, attestedAt, sdkNullifierRule, paidOn: paid?.paidOn ?? null, verifier: V2_VERIFIER_BASE_SEPOLIA, onChain: true, tamperedRejected: true, proofBytes: (result.proof.length - 2) / 2 }));
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

  it('refuses a v1 (signal-hash) nullifier before payment, naming the rule', async () => {
    const scope = 'e2e:coinbase-v2:refusal';
    const signalHash = ethers.keccak256(ethers.solidityPacked(['address', 'string', 'string'], [wallet, scope, 'coinbase_attestation']));
    const scopeBytes = ethers.keccak256(ethers.toUtf8Bytes(scope));
    const v1 = ethers.keccak256(ethers.concat([ethers.keccak256(ethers.concat([wallet, signalHash])), scopeBytes]));
    const res = await proveWith({ signal_hash: signalHash, nullifier: v1, scope_bytes: scopeBytes, user_address: wallet, merkle_root: ethers.ZeroHash });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('NULLIFIER_RULE');
  });

  it('refuses a wallet with no Coinbase attestation before payment', async () => {
    const stranger = ethers.Wallet.createRandom().address;
    const scopeBytes = ethers.keccak256(ethers.toUtf8Bytes('e2e:coinbase-v2:stranger'));
    const tag = ethers.keccak256(ethers.toUtf8Bytes('coinbase_attestation'));
    const nullifier = ethers.keccak256(ethers.concat([ethers.keccak256(ethers.concat([stranger, tag])), scopeBytes]));
    const res = await proveWith({ signal_hash: ethers.ZeroHash.replace(/0$/, '1'), nullifier, scope_bytes: scopeBytes, user_address: stranger, merkle_root: ethers.ZeroHash });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('NO_COINBASE_ATTESTATION');
  });
});
