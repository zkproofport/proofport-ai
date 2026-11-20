import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOidcKeyCache, getPinnedOprfKeyHash, oprfLayoutOf, PINNED_VERIFIERS } from '@zkproofport-app/core';
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

/**
 * A Coinbase KYC proof's public inputs in the OPRF layout (core's count), all
 * zero except the staging OPRF key hash at its offset: every check core runs
 * before the issuer check passes, so the signer-list root is what refuses it.
 */
function kycInputsWithStagingKey(): string {
  const layout = oprfLayoutOf('coinbase_attestation');
  const fields = Array.from({ length: layout.count }, () => '00'.repeat(32));
  fields[layout.keyHash] = getPinnedOprfKeyHash('staging', 'coinbase_attestation').slice(2);
  return '0x' + fields.join('');
}

function response(overrides: Partial<ProveResponse> = {}): ProveResponse {
  return {
    circuit: 'coinbase_attestation',
    proofType: 'kyc',
    proof: '0x' + 'ab'.repeat(64),
    publicInputs: zeros(193),
    proofWithInputs: '',
    attestation: null,
    timing: { totalMs: 0 },
    verification: { chainId: BASE_SEPOLIA, verifierAddress: pinned('coinbase_attestation', BASE_SEPOLIA), rpcUrl: 'https://sepolia.base.org' },
    ...overrides,
  };
}

/** The verifier's own client configuration: the proving service it trusts. */
const CONFIG = { baseUrl: 'https://prover.test' };
const OPRF_URL = `${CONFIG.baseUrl}/api/v1/oprf`;

/**
 * What the verifier's proving service answers at GET /api/v1/oprf. Only that
 * URL answers; every other request fails, so a test sees any other network use.
 */
let serverOprf: { status: number; body: unknown };
let fetchMock: ReturnType<typeof vi.fn>;
const otherCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) !== OPRF_URL);
beforeEach(() => {
  clearOidcKeyCache();
  serverOprf = { status: 200, body: { environment: 'staging' } };
  fetchMock = vi.fn(async (url: unknown) => {
    if (String(url) === OPRF_URL) {
      return new Response(JSON.stringify(serverOprf.body), { status: serverOprf.status, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('network is not allowed in this test');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('AI SDK verifyProof refuses what the response says about its verifier', () => {
  it('refuses a response with no verification info', async () => {
    const result = await verifyProof(CONFIG, response({ verification: null }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('No verification info');
  });

  it('refuses an address that is not the pinned verifier, without calling it', async () => {
    const result = await verifyProof(CONFIG, response({
      verification: { chainId: BASE_SEPOLIA, verifierAddress: ATTACKER, rpcUrl: 'https://sepolia.base.org' },
    }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain(`names verifier ${ATTACKER}`);
    expect(result.error).toContain(pinned('coinbase_attestation', BASE_SEPOLIA));
  });

  it("refuses another circuit's pinned verifier on the same chain", async () => {
    const result = await verifyProof(CONFIG, response({
      verification: { chainId: BASE_SEPOLIA, verifierAddress: pinned('coinbase_country_attestation', BASE_SEPOLIA) },
    }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Refusing rather than trusting the response');
  });

  for (const bad of ['', '0x', 'not-an-address', '0x' + 'g'.repeat(40), "0x' OR 1=1 --", '<script>', '0x지갑', pinned('coinbase_attestation', BASE_SEPOLIA) + '00']) {
    it(`refuses verifierAddress ${JSON.stringify(bad)}`, async () => {
      const result = await verifyProof(CONFIG, response({ verification: { chainId: BASE_SEPOLIA, verifierAddress: bad } }));
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }

  it('refuses a response with no verifierAddress at all', async () => {
    const result = await verifyProof(CONFIG, response({
      verification: { chainId: BASE_SEPOLIA } as unknown as ProveResponse['verification'],
    }));
    expect(result).toEqual({ valid: false, error: 'The response names no verifier address; refusing to guess one.' });
  });

  for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '84532', null, undefined]) {
    it(`refuses chainId ${String(bad)} (${typeof bad})`, async () => {
      const result = await verifyProof(CONFIG, response({
        verification: { chainId: bad as unknown as number, verifierAddress: pinned('coinbase_attestation', BASE_SEPOLIA) },
      }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not a chain id');
    });
  }

  it('refuses a chain this SDK has no RPC for, naming it', async () => {
    const result = await verifyProof(CONFIG, response({ verification: { chainId: 999, verifierAddress: ATTACKER } }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('No RPC to verify on chain 999');
  });

  it('refuses a chain the circuit has no pinned deployment on (GIWA on Base Sepolia)', async () => {
    const result = await verifyProof(CONFIG, response({
      circuit: 'giwa_attestation',
      publicInputs: zeros(192),
      verification: { chainId: BASE_SEPOLIA, verifierAddress: pinned('coinbase_attestation', BASE_SEPOLIA) },
    }));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('84532');
  });

  for (const circuit of ['arc_eligibility', '', 'COINBASE_ATTESTATION', 'coinbase-attestation']) {
    it(`refuses circuit ${JSON.stringify(circuit)}`, async () => {
      const result = await verifyProof(CONFIG, response({ circuit }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown circuit');
    });
  }

  it('refuses a Coinbase proof whose signer-list root is not Coinbase\'s, before any contract call', async () => {
    // Correct pinned address and the pinned OPRF key, so only the issuer check can refuse it.
    const result = await verifyProof(CONFIG, { ...response({ publicInputs: kycInputsWithStagingKey() }), oprfEnvironment: 'staging' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/root/i);
    expect(otherCalls()).toEqual([]);
  });
});

describe('AI SDK verifyProof takes the OPRF environment from the verifier, never from the result', () => {
  // The proof's public inputs carry the staging key hash. A result made by
  // someone else could claim 'staging' to be checked against that public
  // test-network key; only the verifier's own side decides which key applies.
  const kyc = () => response({ publicInputs: kycInputsWithStagingKey() });

  it("uses the environment of the verifier's proving service (config.baseUrl) when the result names none", async () => {
    const result = await verifyProof(CONFIG, kyc());
    expect(fetchMock).toHaveBeenCalledWith(OPRF_URL, expect.objectContaining({ method: 'GET' }));
    expect(result.error).not.toContain('OPRF environment');
    expect(result.error).toMatch(/root/i);
  });

  it("passes the environment check when the result's matches the verifier's service", async () => {
    const result = await verifyProof(CONFIG, { ...kyc(), oprfEnvironment: 'staging' });
    expect(result.error).not.toContain('OPRF environment');
    expect(result.error).toMatch(/root/i);
  });

  it.each(['local', 'production'])("refuses a result claiming 'staging' when the verifier's service is %s, naming both", async env => {
    serverOprf = { status: 200, body: { environment: env } };
    const result = await verifyProof(CONFIG, { ...kyc(), oprfEnvironment: 'staging' });
    expect(result).toEqual({
      valid: false,
      error: `The result names the 'staging' OPRF environment, but this verifier checks against '${env}'; refusing it.`,
    });
    expect(otherCalls()).toEqual([]);
  });

  it('refuses by name when the service answers without an environment (no OPRF_ENVIRONMENT there)', async () => {
    serverOprf = { status: 503, body: { message: 'OPRF_ENVIRONMENT is not set on this server' } };
    const result = await verifyProof(CONFIG, { ...kyc(), oprfEnvironment: 'staging' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain(`${OPRF_URL} did not name an OPRF environment: OPRF_ENVIRONMENT is not set on this server`);
    expect(result.error).toContain('coinbase_attestation');
  });

  it.each([
    [{}, 'undefined'],
    [{ environment: null }, 'null'],
    [{ environment: 'prod' }, '"prod"'],
    [{ environment: 'Staging' }, '"Staging"'],
    [{ environment: '' }, '""'],
  ])('refuses a service naming environment %j, with the known ones', async (body, shown) => {
    serverOprf = { status: 200, body };
    const result = await verifyProof(CONFIG, kyc());
    expect(result.valid).toBe(false);
    expect(result.error).toContain(`named OPRF environment ${shown}. Known:`);
  });

  it('refuses when the service cannot be reached, naming the URL', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('getaddrinfo ENOTFOUND prover.test'); });
    const result = await verifyProof(CONFIG, { ...kyc(), oprfEnvironment: 'staging' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain(`Could not reach ${OPRF_URL}`);
  });

  it("takes the caller's explicit environment without asking the service", async () => {
    const result = await verifyProof(CONFIG, kyc(), { oprfEnvironment: 'local' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.error).toMatch(/root/i);
  });

  it("refuses when the caller's explicit environment and the result's differ, naming both", async () => {
    const result = await verifyProof(CONFIG, { ...kyc(), oprfEnvironment: 'staging' }, { oprfEnvironment: 'local' });
    expect(result).toEqual({
      valid: false,
      error: "The result names the 'staging' OPRF environment, but this verifier checks against 'local'; refusing it.",
    });
  });

  it('an explicit environment wins over the service: a staging result is refused when the caller says production', async () => {
    const result = await verifyProof(CONFIG, { ...kyc(), oprfEnvironment: 'staging' }, { oprfEnvironment: 'production' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("'staging'");
    expect(result.error).toContain("'production'");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses production by name: no OPRF key is pinned there', async () => {
    serverOprf = { status: 200, body: { environment: 'production' } };
    const result = await verifyProof(CONFIG, kyc());
    expect(result.valid).toBe(false);
    expect(result.error).toContain("No OPRF key is registered for the 'production' environment");
  });

  it.each(['prod', '', 'Staging'])('refuses unknown explicit environment %j by name', async env => {
    const result = await verifyProof(CONFIG, kyc(), { oprfEnvironment: env });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unknown OPRF environment');
  });

  it('refuses a result naming an environment on a proof without an OPRF nullifier (OIDC), asking nothing', async () => {
    const result = await verifyProof(CONFIG, {
      ...response({ circuit: 'oidc_domain_attestation', publicInputs: oidcV2Inputs(),
        verification: { chainId: ETH_SEPOLIA, verifierAddress: pinned('oidc_domain_attestation', ETH_SEPOLIA) } }),
      oprfEnvironment: 'staging',
    });
    expect(result).toEqual({
      valid: false,
      error: "The result names the 'staging' OPRF environment, but this verifier checks against none; refusing it.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a pre-OPRF (193-input) Coinbase proof by name', async () => {
    const result = await verifyProof(CONFIG, { ...response(), oprfEnvironment: 'staging' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('193 public inputs');
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
    const result = await verifyProof(CONFIG, oidc());
    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not publish');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('googleapis.com');
  });

  it('fails closed when the key list cannot be fetched', async () => {
    const result = await verifyProof(CONFIG, oidc());
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Verification failed');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('refuses a mismatching address before fetching any key list', async () => {
    const result = await verifyProof(CONFIG, oidc(ATTACKER));
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
