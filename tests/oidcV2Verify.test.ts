import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOidcKeyCache, PINNED_VERIFIERS, OIDC_NOW_MAX_AGE_SECONDS, OIDC_NOW_MAX_FUTURE_SECONDS,
  OIDC_ALLOWED_AUDIENCES, OIDC_PUBLIC_INPUT_COUNT as CORE_OIDC_PUBLIC_INPUT_COUNT,
} from '@zkproofport-app/core';
import { verifyProof } from '../packages/sdk/src/verify.js';
import type { ProveResponse } from '../packages/sdk/src/types.js';
import { verifyOnChain as serverVerify } from '../src/prover/verifier.js';
import { FALLBACK_VERIFIERS } from '../src/config/contracts.js';
import { OIDC_PROVIDERS, OIDC_PUBLIC_INPUT_COUNT as SERVER_COUNT, OIDC_DEVICE_NONCE_MODE, OIDC_IAT_CLOCK_SKEW_SECONDS } from '../src/prover/oidcProver.js';
import { OIDC_DEVICE_PROVIDERS, OIDC_PUBLIC_INPUT_COUNT as SDK_COUNT } from '../packages/sdk/src/oidc-inputs.js';
import { oidcV2Inputs, oidcV2InputArray, type OidcV2InputOverrides } from './helpers/oidcV2Inputs.js';

/**
 * OIDC v2 (214 public inputs) through both verify paths of this repository,
 * running the REAL @zkproofport-app/core: the AI SDK's verifyProof (which the
 * MCP verify_proof tool calls) and the server's src/prover/verifier.ts.
 *
 * Core's policy runs before the provider-key fetch and the contract call. A
 * case refused by policy must therefore never reach `fetch`; a case that
 * passes policy must reach the key fetch (stubbed here to fail), which proves
 * the policy accepted it. No case reaches a chain.
 */

const BASE_SEPOLIA = 84532;
const ETH_SEPOLIA = 11155111;
const GOOGLE_WEB_CLIENT = '491923400813-5bb3up7dhejns2unvbrt6mku520hrr5g.apps.googleusercontent.com';
const MICROSOFT_CLIENT = '8b09c842-d7a8-4d9c-a6ea-46c797412bac';
const GCLOUD_CLIENT = '32555940559.apps.googleusercontent.com';
const now = () => Math.floor(Date.now() / 1000);

function response(o: OidcV2InputOverrides = {}, chainId = ETH_SEPOLIA): ProveResponse {
  return {
    circuit: 'oidc_domain_attestation',
    proofType: 'google_workspace',
    proof: '0x' + 'ab'.repeat(64),
    publicInputs: oidcV2Inputs(o),
    proofWithInputs: '',
    attestation: null,
    timing: { totalMs: 0 },
    verification: { chainId, verifierAddress: PINNED_VERIFIERS.oidc_domain_attestation[chainId].address },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearOidcKeyCache();
  fetchMock = vi.fn(async () => { throw new Error('network is not allowed in this test'); });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

interface Case { name: string; inputs: OidcV2InputOverrides; error: RegExp }

const refusedByPolicy: Case[] = [
  { name: 'a v1 proof (148 inputs), by name', inputs: { count: 148 }, error: /v1 oidc_domain_attestation proof \(148 public inputs\)/ },
  { name: '213 inputs', inputs: { count: 213 }, error: /214 public inputs; got 213/ },
  { name: '215 inputs', inputs: { count: 215 }, error: /214 public inputs; got 215/ },
  { name: 'an audience that is not ours (gcloud)', inputs: { aud: GCLOUD_CLIENT }, error: /not a ZKProofport client for provider 0/ },
  { name: "Google's web client in nonce_mode 0", inputs: { aud: GOOGLE_WEB_CLIENT }, error: /nonce_mode 0 is not accepted/ },
  { name: "Google's device client in nonce_mode 1", inputs: { nonceMode: 1, binding: 'aa'.repeat(32) }, error: /nonce_mode 1 is not accepted/ },
  { name: 'nonce_mode 2', inputs: { nonceMode: 2 }, error: /Unknown OIDC nonce_mode 2/ },
  { name: 'nonce_mode 0 with a non-zero binding', inputs: { binding: '00'.repeat(31) + '01' }, error: /nonce_binding is not all zero/ },
  { name: 'unknown provider 2', inputs: { provider: 2 }, error: /Unknown OIDC provider 2/ },
  { name: "Microsoft's client under provider 0", inputs: { aud: MICROSOFT_CLIENT }, error: /not a ZKProofport client for provider 0/ },
  { name: 'now older than the allowed age', inputs: { now: now() - OIDC_NOW_MAX_AGE_SECONDS - 60 }, error: /behind this verifier's clock/ },
  { name: 'now further ahead than allowed', inputs: { now: now() + OIDC_NOW_MAX_FUTURE_SECONDS + 60 }, error: /ahead of this verifier's clock/ },
  { name: 'now = 0', inputs: { now: 0 }, error: /behind this verifier's clock/ },
];

const passesPolicy: { name: string; inputs: OidcV2InputOverrides; keyHost: string }[] = [
  { name: 'Google device client, mode 0, fresh now', inputs: {}, keyHost: 'googleapis.com' },
  { name: 'Microsoft client, mode 0', inputs: { provider: 1, aud: MICROSOFT_CLIENT }, keyHost: 'microsoftonline.com' },
  { name: 'Microsoft client, mode 1 (no request given)', inputs: { provider: 1, aud: MICROSOFT_CLIENT, nonceMode: 1, binding: 'ab'.repeat(32) }, keyHost: 'microsoftonline.com' },
  { name: 'Google web client, mode 1 (no request given)', inputs: { aud: GOOGLE_WEB_CLIENT, nonceMode: 1, binding: 'cd'.repeat(32) }, keyHost: 'googleapis.com' },
  { name: 'now just inside the allowed age', inputs: { now: now() - OIDC_NOW_MAX_AGE_SECONDS + 30 }, keyHost: 'googleapis.com' },
];

describe('AI SDK / MCP verifyProof on OIDC v2 proofs', () => {
  for (const c of refusedByPolicy) {
    it(`refuses ${c.name} before any key fetch`, async () => {
      const result = await verifyProof(response(c.inputs));
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(c.error);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  for (const c of passesPolicy) {
    it(`passes policy for ${c.name} and reaches the ${c.keyHost} key check`, async () => {
      const result = await verifyProof(response(c.inputs));
      expect(result.valid).toBe(false);
      expect(fetchMock).toHaveBeenCalled();
      expect(String(fetchMock.mock.calls[0][0])).toContain(c.keyHost);
    });
  }

  it('verifies against the v2 verifier pinned on Base Sepolia too', async () => {
    const result = await verifyProof(response({}, BASE_SEPOLIA));
    expect(result.valid).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('server verifyOnChain on OIDC v2 proofs', () => {
  const params = (o: OidcV2InputOverrides = {}, chainId = String(BASE_SEPOLIA)) => ({
    proof: '0x' + 'ab'.repeat(64),
    publicInputs: oidcV2InputArray(o),
    circuitId: 'oidc_domain_attestation',
    chainId,
    rpcUrl: 'http://127.0.0.1:1',
  });

  it('looks up the v2 verifier core pins on both testnets', () => {
    expect(FALLBACK_VERIFIERS['84532'].oidc_domain_attestation?.toLowerCase()).toBe('0x003334a7c2ff15ee9ee845ab88e152a2a3694167');
    expect(FALLBACK_VERIFIERS['11155111'].oidc_domain_attestation?.toLowerCase()).toBe('0x728eed982a3aeb0274fef972ebba9b774a2f9be4');
  });

  for (const c of refusedByPolicy) {
    it(`throws on ${c.name} before any key fetch`, async () => {
      await expect(serverVerify(params(c.inputs))).rejects.toThrow(c.error);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('passes policy on a v2 proof and fails closed at the key check', async () => {
    await expect(serverVerify(params())).rejects.toThrow(/On-chain verification failed/);
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain('googleapis.com');
  });

  it('passes policy on Ethereum Sepolia as well', async () => {
    await expect(serverVerify(params({}, String(ETH_SEPOLIA)))).rejects.toThrow(/On-chain verification failed/);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('what the builders produce is what core accepts', () => {
  it('both builders build as many public inputs as core verifies', () => {
    expect(SERVER_COUNT).toBe(CORE_OIDC_PUBLIC_INPUT_COUNT);
    expect(SDK_COUNT).toBe(CORE_OIDC_PUBLIC_INPUT_COUNT);
  });

  for (const [name, tables] of [['server', OIDC_PROVIDERS], ['SDK', OIDC_DEVICE_PROVIDERS]] as const) {
    for (const [provider, row] of Object.entries(tables)) {
      it(`the ${name} builder's ${provider} device client is accepted by core in the mode it proves in`, () => {
        const accepted = OIDC_ALLOWED_AUDIENCES[String(row.circuitValue)];
        expect(accepted, `core knows no provider ${row.circuitValue}`).toBeDefined();
        const audience = accepted.find(a => a.clientId === row.deviceClientId);
        expect(audience, `${row.deviceClientId} is not in core's allowed audiences`).toBeDefined();
        expect(audience!.nonceModes).toContain(OIDC_DEVICE_NONCE_MODE);
      });
    }
  }

  it("the server's iat skew stays inside how far ahead core accepts now", () => {
    expect(OIDC_IAT_CLOCK_SKEW_SECONDS).toBeLessThanOrEqual(OIDC_NOW_MAX_FUTURE_SECONDS);
  });
});
