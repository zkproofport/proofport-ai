import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOidcKeyCache, PINNED_VERIFIERS } from '@zkproofport-app/core';
import { verifyProof, verifyRpcUrl, VERIFY_RPC_URLS } from '../packages/sdk/src/verify.js';
import type { ProveResponse } from '../packages/sdk/src/types.js';
import { oidcV2Inputs } from './helpers/oidcV2Inputs.js';

/**
 * The AI SDK's verifyProof (and the MCP verify_proof tool built on it) used to
 * hand core the server response's verifierAddress as if the caller had
 * configured it. A response naming a contract that always returns true then
 * "verified" anything. These tests run the REAL core: every case here is
 * refused before any contract call, so none of them needs a network -- except
 * the OIDC key fetch, which is stubbed.
 */

const BASE_SEPOLIA = 84532;
const ETH_SEPOLIA = 11155111;
const pinned = (circuit: keyof typeof PINNED_VERIFIERS, chain: number) => PINNED_VERIFIERS[circuit][chain].address;
const ATTACKER = '0x000000000000000000000000000000000000dEaD';

function zeros(fields: number): string {
  return '0x' + '00'.repeat(32 * fields);
}

function response(overrides: Partial<ProveResponse> = {}): ProveResponse {
  return {
    circuit: 'coinbase_attestation',
    proofType: 'kyc',
    proof: '0x' + 'ab'.repeat(64),
    publicInputs: zeros(128),
    proofWithInputs: '',
    attestation: null,
    timing: { totalMs: 0 },
    verification: { chainId: BASE_SEPOLIA, verifierAddress: pinned('coinbase_attestation', BASE_SEPOLIA), rpcUrl: 'https://sepolia.base.org' },
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearOidcKeyCache();
  fetchMock = vi.fn(async () => { throw new Error('network is not allowed in this test'); });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('AI SDK verifyProof refuses what the response says about its verifier', () => {
  it('refuses a response with no verification info', async () => {
    const result = await verifyProof(response({ verification: null }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('No verification info');
  });

  it('refuses an address that is not the pinned verifier, without calling it', async () => {
    const result = await verifyProof(response({
      verification: { chainId: BASE_SEPOLIA, verifierAddress: ATTACKER, rpcUrl: 'https://sepolia.base.org' },
    }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain(`names verifier ${ATTACKER}`);
    expect(result.error).toContain(pinned('coinbase_attestation', BASE_SEPOLIA));
  });

  it("refuses another circuit's pinned verifier on the same chain", async () => {
    const result = await verifyProof(response({
      verification: { chainId: BASE_SEPOLIA, verifierAddress: pinned('coinbase_country_attestation', BASE_SEPOLIA) },
    }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Refusing rather than trusting the response');
  });

  for (const bad of ['', '0x', 'not-an-address', '0x' + 'g'.repeat(40), "0x' OR 1=1 --", '<script>', '0x지갑', pinned('coinbase_attestation', BASE_SEPOLIA) + '00']) {
    it(`refuses verifierAddress ${JSON.stringify(bad)}`, async () => {
      const result = await verifyProof(response({ verification: { chainId: BASE_SEPOLIA, verifierAddress: bad } }));
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }

  it('refuses a response with no verifierAddress at all', async () => {
    const result = await verifyProof(response({
      verification: { chainId: BASE_SEPOLIA } as unknown as ProveResponse['verification'],
    }));
    expect(result).toEqual({ valid: false, error: 'The response names no verifier address; refusing to guess one.' });
  });

  for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '84532', null, undefined]) {
    it(`refuses chainId ${String(bad)} (${typeof bad})`, async () => {
      const result = await verifyProof(response({
        verification: { chainId: bad as unknown as number, verifierAddress: pinned('coinbase_attestation', BASE_SEPOLIA) },
      }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not a chain id');
    });
  }

  it('refuses a chain this SDK has no RPC for, naming it', async () => {
    const result = await verifyProof(response({ verification: { chainId: 999, verifierAddress: ATTACKER } }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('No RPC to verify on chain 999');
  });

  it('refuses a chain the circuit has no pinned deployment on (GIWA on Base Sepolia)', async () => {
    const result = await verifyProof(response({
      circuit: 'giwa_attestation',
      publicInputs: zeros(192),
      verification: { chainId: BASE_SEPOLIA, verifierAddress: pinned('coinbase_attestation', BASE_SEPOLIA) },
    }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('84532');
  });

  for (const circuit of ['arc_eligibility', '', 'COINBASE_ATTESTATION', 'coinbase-attestation']) {
    it(`refuses circuit ${JSON.stringify(circuit)}`, async () => {
      const result = await verifyProof(response({ circuit }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown circuit');
    });
  }

  it('refuses a Coinbase proof whose signer-list root is not Coinbase\'s, before any contract call', async () => {
    // Correct pinned address, so only the issuer check can refuse it.
    const result = await verifyProof(response());
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/root/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AI SDK verifyProof checks the OIDC provider key through core', () => {
  // v2 layout (214 inputs). A well-formed 2048-bit modulus (18 limbs of 120
  // bits, top limb 0xff) that no provider publishes; provider 0 (Google); the
  // Google device client's aud_hash, nonce_mode 0, zero binding, now = clock.
  // Everything core's OIDC policy checks passes, so the refusal below can only
  // come from the provider-key check.
  const oidc = (verifierAddress = pinned('oidc_domain_attestation', ETH_SEPOLIA)) => response({
    circuit: 'oidc_domain_attestation',
    proofType: 'google_workspace',
    publicInputs: oidcV2Inputs(),
    verification: { chainId: ETH_SEPOLIA, verifierAddress, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com' },
  });

  it('refuses a key Google does not publish', async () => {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ keys: [{ kty: 'RSA', alg: 'RS256', use: 'sig', kid: 'k1', e: 'AQAB', n: 'x'.repeat(342) }] }),
      { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } },
    ));
    const result = await verifyProof(oidc());
    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not publish');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('googleapis.com');
  });

  it('fails closed when the key list cannot be fetched', async () => {
    const result = await verifyProof(oidc());
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Verification failed');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('refuses a mismatching address before fetching any key list', async () => {
    const result = await verifyProof(oidc(ATTACKER));
    expect(result.valid).toBe(false);
    expect(result.error).toContain(`names verifier ${ATTACKER}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the RPC used to verify', () => {
  it('has one for every chain a circuit is pinned on', () => {
    for (const [circuit, chains] of Object.entries(PINNED_VERIFIERS)) {
      for (const chain of Object.keys(chains)) {
        expect(() => verifyRpcUrl(Number(chain)), `${circuit} on ${chain}`).not.toThrow();
      }
    }
  });

  it('throws naming an unknown chain and the known ones', () => {
    expect(() => verifyRpcUrl(424242)).toThrow(/No RPC to verify on chain 424242\. Known chains: .*11155111/);
  });

  it('is https for every chain', () => {
    for (const url of Object.values(VERIFY_RPC_URLS)) expect(url.startsWith('https://')).toBe(true);
  });

});
