/**
 * The OPRF step inside the SDK's flows, against a simulated network whose key
 * is pinned for 'local' (the tables are mocked here only; oprfMirror.test.ts
 * holds the real rows). Checks the ORDER that protects the user: names and the
 * service's environment are checked before the wallet signs anything, and a
 * production service is refused before any signature, socket or payment.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';

const sim = await vi.hoisted(async () => {
  const { simulatedNetwork } = await import('./helpers/oprfSimulatedNetwork.js');
  return simulatedNetwork({ secret: 0xabcdef0123456789n });
});

vi.mock('../packages/sdk/src/oprf/networks.js', async importOriginal => {
  const real = await importOriginal<typeof import('../packages/sdk/src/oprf/networks.js')>();
  return {
    ...real,
    getOprfNetwork: (env: unknown) => (env === 'local' ? sim.network : real.getOprfNetwork(env)),
  };
});
vi.mock('../packages/sdk/src/oprf/keyHashes.js', async importOriginal => {
  const real = await importOriginal<typeof import('../packages/sdk/src/oprf/keyHashes.js')>();
  const { oprfKeyHash } = await import('../packages/sdk/src/oprf/core/client.js');
  const simHash = oprfKeyHash(sim.publicKey);
  return {
    ...real,
    getPinnedOprfKeyHash: (env: unknown, circuit: unknown) => {
      const hash = real.getPinnedOprfKeyHash(env === 'local' ? 'staging' : env, circuit); // same refusals
      return env === 'local' ? simHash : hash;
    },
  };
});

const { evaluateOprf, checkPreparedOprf, OPRF_INPUT_KEYS } = await import('../packages/sdk/src/oprf/index.js');
const { prepareHumanPassportInputs } = await import('../packages/sdk/src/inputs.js');
const { generateProof } = await import('../packages/sdk/src/flow.js');
const { fromPrivateKey } = await import('../packages/sdk/src/signer.js');
const { requestSignalHash } = await import('../packages/sdk/src/inputs.js');

const wallet = ethers.Wallet.createRandom();
const signer = fromPrivateKey(wallet.privateKey);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('evaluateOprf end to end (simulated network, local)', () => {
  it('returns 11 values that re-verify, and a fresh beta each time with the same nullifier', async () => {
    const args = { environment: 'local' as const, circuitId: 'human_passport_score', address: wallet.address, domainName: 'app.example.com', scopeName: 'vote 2026', webSocket: sim.factory, timeoutMs: 500 };
    const a = await evaluateOprf(args);
    const b = await evaluateOprf(args);
    expect(Object.keys(a).sort()).toEqual([...OPRF_INPUT_KEYS].sort());
    expect(a.nullifier).toBe(b.nullifier);
    expect(a.oprf_beta).not.toBe(b.oprf_beta);
    const prepared = { environment: 'local' as const, circuitId: 'human_passport_score', address: wallet.address, oprfDomain: 'app.example.com', scope: 'vote 2026', inputs: a };
    expect(checkPreparedOprf(prepared, { circuitId: 'human_passport_score', address: wallet.address, scope: 'vote 2026' })).toEqual(a);
  });

  it('another domain or scope gives another nullifier for the same wallet', async () => {
    const base = { environment: 'local' as const, circuitId: 'coinbase_attestation', address: wallet.address, webSocket: sim.factory, timeoutMs: 500 };
    const x = await evaluateOprf({ ...base, domainName: 'a.example', scopeName: 's' });
    const y = await evaluateOprf({ ...base, domainName: 'b.example', scopeName: 's' });
    const z = await evaluateOprf({ ...base, domainName: 'a.example', scopeName: 't' });
    const swapped = await evaluateOprf({ ...base, domainName: 's', scopeName: 'a.example' });
    expect(new Set([x.nullifier, y.nullifier, z.nullifier, swapped.nullifier]).size).toBe(4);
  });

  it('staging pins the real test network key: the simulated network\'s answer is refused', async () => {
    await expect(evaluateOprf({ environment: 'staging', circuitId: 'coinbase_attestation', address: wallet.address, domainName: 'a', scopeName: 'b', webSocket: url => sim.factory(url.replace(/^wss:\/\/node(\d)\.eu\.test\.oprf\.taceo\.network/, 'wss://node$1.sim.test')), timeoutMs: 500 }))
      .rejects.toThrow(/not the pinned/);
  });

  it('feeds prepareHumanPassportInputs, which spreads the 11 values and no keccak scope/nullifier', async () => {
    const inputs = await evaluateOprf({ environment: 'local', circuitId: 'human_passport_score', address: wallet.address, domainName: 'app.example.com', scopeName: 'vote', webSocket: sim.factory, timeoutMs: 500 });
    const requestId = '3f2b8c1e-9d4a-4f6b-8e2c-1a7d5b9c0e4f';
    const signature = await wallet.signMessage(requestSignalHash('human_passport_score', 'vote', requestId, false));
    const out = prepareHumanPassportInputs({
      userAddress: wallet.address, userSignature: signature, scope: 'vote', minScore: 20, chain: 8453, requestId,
      oprf: { environment: 'local', circuitId: 'human_passport_score', address: wallet.address, oprfDomain: 'app.example.com', scope: 'vote', inputs },
    });
    for (const k of OPRF_INPUT_KEYS) expect((out as unknown as Record<string, string>)[k]).toBe(inputs[k]);
    expect(out).not.toHaveProperty('scope_bytes');
    // An evaluation for another scope is refused.
    expect(() => prepareHumanPassportInputs({
      userAddress: wallet.address, userSignature: signature, scope: 'vote', minScore: 20, chain: 8453, requestId,
      oprf: { environment: 'local', circuitId: 'human_passport_score', address: wallet.address, oprfDomain: 'app.example.com', scope: 'other', inputs },
    })).toThrow(/made for scope/);
    // ...and a missing one.
    expect(() => prepareHumanPassportInputs({
      userAddress: wallet.address, userSignature: signature, scope: 'vote', minScore: 20, chain: 8453, requestId,
      oprf: undefined as never,
    })).toThrow(/missing: call prepareOprf/);
  });
});

describe('generateProof: what is refused before the wallet signs', () => {
  const config = { baseUrl: 'https://svc.test' };

  it.each([
    ['no oprfDomain', { circuit: 'coinbase_kyc' as const, scope: 's' }, /oprfDomain is required/],
    ['empty oprfDomain', { circuit: 'giwa_attestation' as const, scope: 's', oprfDomain: '' }, /empty/],
    ['whitespace-only oprfDomain is a name, but a newline is not', { circuit: 'coinbase_kyc' as const, scope: 's', oprfDomain: '\n' }, /control-character/],
    ['a scope the OPRF network refuses (257 bytes)', { circuit: 'coinbase_kyc' as const, scope: 'x'.repeat(257), oprfDomain: 'a' }, /too-long/],
    ['oprfDomain on OIDC', { circuit: 'oidc_domain' as const, scope: 's', oprfDomain: 'a', jwt: 'x.y.z' }, /applies to wallet circuits/],
  ])('%s', async (_l, params, re) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const sign = vi.spyOn(signer, 'signMessage');
    await expect(generateProof(config, { attestation: signer }, params as never)).rejects.toThrow(re);
    expect(sign).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an action with no oprfDomain is refused before a human is asked to approve anything', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const action = {
      domain: { name: 'Vault', version: '1', chainId: 8453, verifyingContract: '0x' + '11'.repeat(20) },
      types: { Deposit: [{ name: 'amount', type: 'uint256' }] }, primaryType: 'Deposit', message: { amount: '1' },
    };
    await expect(generateProof(config, { attestation: signer }, { circuit: 'giwa_attestation', scope: 's', action }))
      .rejects.toThrow(/oprfDomain is required/);
    // No approval was created: that is a request to the service.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a production service is refused by name: no signature, no socket, no challenge, no payment', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/oprf')) return new Response(JSON.stringify({ environment: 'production' }), { status: 200 });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);
    const sign = vi.spyOn(signer, 'signMessage');
    await expect(generateProof(config, { attestation: signer }, { circuit: 'coinbase_kyc', scope: 's', oprfDomain: 'app.example.com' }))
      .rejects.toThrow(/No OPRF network is registered for the 'production' environment/);
    expect(sign).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.map(c => c[0])).toEqual(['https://svc.test/api/v1/oprf']);
  });

  it('a service that names no environment is refused before signing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'OPRF_NOT_CONFIGURED', message: 'OPRF_ENVIRONMENT is not set' }), { status: 503 })));
    const sign = vi.spyOn(signer, 'signMessage');
    await expect(generateProof(config, { attestation: signer }, { circuit: 'human_passport', scope: 's', oprfDomain: 'a', minScore: 20, chain: 8453 }))
      .rejects.toThrow(/OPRF_ENVIRONMENT is not set/);
    expect(sign).not.toHaveBeenCalled();
  });
});
