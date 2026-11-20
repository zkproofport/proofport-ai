/**
 * signal_hash without the wallet: keccak256(scope ++ circuitId ++ requestId),
 * the AI repository's one implementation (packages/sdk/src/signalHash.ts,
 * a mirror of @zkproofport-app/core until core ships it), and the request id
 * the SDK and MCP bind.
 *
 * Matrix, written before the code:
 *  - shared vectors (byte-identical to core's; oracle: ethers solidityPackedKeccak256)
 *  - the address is not in the preimage: two wallets, one request, one hash
 *  - same request -> same hash; another requestId / scope / circuit -> another
 *  - scope: empty, whitespace, null, number, unpaired surrogates, 4096 ok, 4097,
 *    multibyte crossing the cap, hostile text accepted as plain bytes
 *  - requestId: empty, null, 128 ok, 129, '_', space, non-ASCII
 *  - circuit: unknown, hyphenated, OIDC refused by name
 *  - prepareInputs: zeros with an action, requestId required without one
 *  - generateProof: mints a fresh UUID per proof and returns it; uses the
 *    caller's; refuses a bad one before signing; action -> zero signal_hash
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import {
  computeSignalHash,
  newRequestId,
  resolveRequestId,
  SIGNAL_HASH_CIRCUIT_IDS,
  SIGNAL_HASH_MAX_SCOPE_BYTES,
  SIGNAL_HASH_MAX_REQUEST_ID_LENGTH,
} from '../packages/sdk/src/signalHash.js';
import { requestSignalHash, prepareHumanPassportInputs } from '../packages/sdk/src/inputs.js';
import * as sdkIndex from '../packages/sdk/src/index.js';
import { STUB_OPRF_INPUTS } from './helpers/oprfStub.js';

const capture = vi.hoisted(() => ({ prepared: [] as Record<string, unknown>[] }));
vi.mock('../packages/sdk/src/inputs.js', async (original) => {
  const real = await original<typeof import('../packages/sdk/src/inputs.js')>();
  return {
    ...real,
    prepareInputs: vi.fn(async (_config: unknown, params: Record<string, unknown>) => {
      capture.prepared.push(params);
      return { signal_hash: '0xprepared' };
    }),
  };
});
vi.mock('../packages/sdk/src/oprf/index.js', async orig => (await import('./helpers/oprfStub.js')).stubOprf(await orig()));
const { generateProof } = await import('../packages/sdk/src/flow.js');

const vectors = JSON.parse(readFileSync(new URL('./fixtures/signal-hash-vectors.json', import.meta.url), 'utf8')) as {
  vectors: { note: string; scope: string; circuitId: string; requestId: string; signalHash: string }[];
};
const REQ = '3f2b8c1e-9d4a-4f6b-8e2c-1a7d5b9c0e4f';
const OTHER_REQ = '9a1c7e3b-2f5d-4c8a-b6e1-0d4f2a8c6b19';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = (b: Uint8Array) => ethers.hexlify(b);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); capture.prepared.length = 0; });

describe('computeSignalHash', () => {
  it.each(vectors.vectors.map(v => [v.note, v] as const))('matches the shared vector: %s', (_n, v) => {
    expect(hex(computeSignalHash({ scope: v.scope, circuitId: v.circuitId, requestId: v.requestId }))).toBe(v.signalHash);
  });

  it('carries no wallet: no wallet-prefixed preimage reproduces a vector', () => {
    for (const v of vectors.vectors) {
      for (const wallet of [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address]) {
        expect(v.signalHash).not.toBe(ethers.solidityPackedKeccak256(['address', 'string', 'string'], [wallet, v.scope, v.circuitId]));
        expect(v.signalHash).not.toBe(ethers.solidityPackedKeccak256(['address', 'string', 'string', 'string'], [wallet, v.scope, v.circuitId, v.requestId]));
      }
    }
  });

  it('two wallets proving the same request sign the same signal_hash', async () => {
    const a = ethers.Wallet.createRandom();
    const b = ethers.Wallet.createRandom();
    const ha = requestSignalHash('coinbase_attestation', 'myapp.com', REQ, false);
    const hb = requestSignalHash('coinbase_attestation', 'myapp.com', REQ, false);
    expect(hex(ha)).toBe(hex(hb));
    // and each wallet's personal_sign over it recovers that wallet
    expect(ethers.verifyMessage(ha, await a.signMessage(ha))).toBe(a.address);
    expect(ethers.verifyMessage(hb, await b.signMessage(hb))).toBe(b.address);
  });

  it('is stable per request and differs per request, scope and circuit', () => {
    const base = { scope: 'myapp.com', circuitId: 'coinbase_attestation', requestId: REQ };
    const h = hex(computeSignalHash(base));
    expect(hex(computeSignalHash({ ...base }))).toBe(h);
    expect(hex(computeSignalHash({ ...base, requestId: OTHER_REQ }))).not.toBe(h);
    expect(hex(computeSignalHash({ ...base, scope: 'myapp.co' }))).not.toBe(h);
    expect(hex(computeSignalHash({ ...base, circuitId: 'coinbase_country_attestation' }))).not.toBe(h);
    expect(computeSignalHash(base)).toHaveLength(32);
  });

  it('covers every circuit with a signal_hash and not OIDC', () => {
    expect([...SIGNAL_HASH_CIRCUIT_IDS].sort()).toEqual(
      ['coinbase_attestation', 'coinbase_country_attestation', 'dojang_playground', 'giwa_attestation', 'human_passport_score'],
    );
  });

  it.each([
    ['unknown id', 'coinbase_kyc', /Unknown circuit 'coinbase_kyc'\. Known: coinbase_attestation/],
    ['hyphenated name', 'coinbase-attestation', /Unknown circuit 'coinbase-attestation'/],
    ['OIDC', 'oidc_domain_attestation', /oidc_domain_attestation has no signal_hash\. Circuits that do: /],
  ])('refuses the circuit: %s', (_n, circuitId, msg) => {
    expect(() => computeSignalHash({ scope: 'x', circuitId, requestId: REQ })).toThrow(msg);
  });

  it.each([
    ['empty', '', /scope is empty/],
    ['whitespace only', ' \n\t', /scope is empty/],
    ['null', null, /scope must be a string, got null/],
    ['a number', 7, /scope must be a string, got number/],
    ['an unpaired high surrogate', 'a\uD800b', /unpaired surrogate at index 1/],
    ['an unpaired low surrogate', '\uDFFF', /unpaired surrogate at index 0/],
    ['4097 bytes', 'a'.repeat(SIGNAL_HASH_MAX_SCOPE_BYTES + 1), /4097 bytes; the limit is 4096/],
    ['1366 Korean characters', '가'.repeat(1366), /4098 bytes/],
  ])('refuses the scope: %s', (_n, scope, msg) => {
    expect(() => computeSignalHash({ scope: scope as string, circuitId: 'coinbase_attestation', requestId: REQ })).toThrow(msg);
  });

  it('accepts a 4096-byte scope, emoji pairs and hostile text as plain bytes', () => {
    for (const scope of ['a'.repeat(4096), '🔐', "%_\\' OR 1=1; <script>x</script>"]) {
      expect(() => computeSignalHash({ scope, circuitId: 'coinbase_attestation', requestId: REQ })).not.toThrow();
    }
  });

  it.each([
    ['empty', '', /requestId is empty/],
    ['null', null, /requestId must be a string, got null/],
    ['129 characters', 'x'.repeat(SIGNAL_HASH_MAX_REQUEST_ID_LENGTH + 1), /129 characters; the limit is 128/],
    ['an underscore', 'req_1', /only ASCII letters, digits and '-'/],
    ['a space', 'req 1', /only ASCII/],
    ['non-ASCII', '요청', /only ASCII/],
  ])('refuses the requestId: %s', (_n, requestId, msg) => {
    expect(() => computeSignalHash({ scope: 'x', circuitId: 'coinbase_attestation', requestId: requestId as string })).toThrow(msg);
    expect(() => resolveRequestId(requestId)).toThrow(msg);
  });

  it('accepts a 128-character request id', () => {
    expect(() => computeSignalHash({ scope: 'x', circuitId: 'coinbase_attestation', requestId: 'x'.repeat(128) })).not.toThrow();
  });

  it('mints a fresh lowercase UUID v4 each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(resolveRequestId(undefined)).toMatch(UUID_V4);
    expect(resolveRequestId('req-given-1')).toBe('req-given-1');
  });

  it('is exported from the SDK package, and the address-based helper is gone from inputs', () => {
    expect(sdkIndex.computeSignalHash).toBe(computeSignalHash);
  });
});

/** A stubbed OPRF evaluation for human_passport_score (checkPreparedOprf is stubbed in this file). */
const hpOprf = (address: string) => ({
  environment: 'staging' as const, circuitId: 'human_passport_score', address, oprfDomain: 'app.example.com', scope: 'app',
  inputs: { ...STUB_OPRF_INPUTS } as never,
});

describe('requestSignalHash (what prepareInputs puts in the inputs)', () => {
  it('is all zeros with an action, whatever the request id', () => {
    expect(hex(requestSignalHash('giwa_attestation', 'x', undefined, true))).toBe(ethers.ZeroHash);
    expect(hex(requestSignalHash('giwa_attestation', 'x', REQ, true))).toBe(ethers.ZeroHash);
  });

  it('requires a request id without one', () => {
    expect(() => requestSignalHash('coinbase_attestation', 'x', undefined, false)).toThrow(/requestId is required for a coinbase_attestation proof without an action/);
  });

  it('human_passport_score carries the request-bound hash and zeros with an action', async () => {
    const wallet = ethers.Wallet.createRandom();
    const signal = computeSignalHash({ scope: 'app', circuitId: 'human_passport_score', requestId: REQ });
    const out = prepareHumanPassportInputs({ userAddress: wallet.address, userSignature: await wallet.signMessage(signal), scope: 'app', minScore: 20, chain: 8453, requestId: REQ, oprf: hpOprf(wallet.address) });
    expect(out.signal_hash).toBe(hex(signal));
    const domain = { name: 'V', version: '1', chainId: 8453, verifyingContract: '0x' + '33'.repeat(20) };
    const types = { Deposit: [{ name: 'amount', type: 'uint256' }] };
    const bound = prepareHumanPassportInputs({
      userAddress: wallet.address, userSignature: await wallet.signTypedData(domain, types, { amount: 1n }), scope: 'app', minScore: 20, chain: 8453,
      domainSeparator: ethers.TypedDataEncoder.hashDomain(domain), actionHash: ethers.TypedDataEncoder.from(types).hash({ amount: 1n }),
      oprf: hpOprf(wallet.address),
    });
    expect(bound.signal_hash).toBe(ethers.ZeroHash);
  });
});

describe('generateProof binds a request id', () => {
  const config = { baseUrl: 'https://ai.example.test' };
  const wallet = ethers.Wallet.createRandom();
  function signer() {
    return { getAddress: vi.fn(async () => wallet.address), signMessage: vi.fn(async (m: Uint8Array) => wallet.signMessage(m)) };
  }
  function serve() {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!new Headers(init?.headers).has('X-Payment-Nonce')) {
        return Response.json({ nonce: 'nonce-fixture', requiresPayment: false, accepts: [] }, { status: 402 });
      }
      return Response.json({ circuit: 'coinbase_attestation', proofType: 'fixture', proof: '0xproof', publicInputs: '0xpublic',
        proofWithInputs: '0xcombined', attestation: null, timing: {}, verification: null });
    });
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  }

  it('without one, mints a fresh UUID per proof, signs its hash and returns it with the scope', async () => {
    serve();
    const s = signer();
    const a = await generateProof(config, { attestation: s }, { circuit: 'coinbase_kyc', scope: 'myapp.com', oprfDomain: 'myapp.com' });
    const b = await generateProof(config, { attestation: s }, { circuit: 'coinbase_kyc', scope: 'myapp.com', oprfDomain: 'myapp.com' });
    expect(a.requestId).toMatch(UUID_V4);
    expect(b.requestId).toMatch(UUID_V4);
    expect(a.requestId).not.toBe(b.requestId);
    expect(a.scope).toBe('myapp.com');
    expect(hex(s.signMessage.mock.calls[0][0])).toBe(hex(computeSignalHash({ scope: 'myapp.com', circuitId: 'coinbase_attestation', requestId: a.requestId! })));
    expect(capture.prepared[0]).toMatchObject({ requestId: a.requestId, userAddress: wallet.address });
  });

  it('uses the caller\'s request id', async () => {
    serve();
    const s = signer();
    const r = await generateProof(config, { attestation: s }, { circuit: 'coinbase_kyc', scope: 'myapp.com', oprfDomain: 'myapp.com', requestId: OTHER_REQ });
    expect(r.requestId).toBe(OTHER_REQ);
    expect(hex(s.signMessage.mock.calls[0][0])).toBe(hex(computeSignalHash({ scope: 'myapp.com', circuitId: 'coinbase_attestation', requestId: OTHER_REQ })));
  });

  it.each([['', /requestId is empty/], ['req_1', /only ASCII/], ['x'.repeat(129), /limit is 128/]])(
    'refuses request id %j before signing or any network call', async (requestId, msg) => {
      const fetcher = serve();
      const s = signer();
      await expect(generateProof(config, { attestation: s }, { circuit: 'coinbase_kyc', scope: 'myapp.com', oprfDomain: 'myapp.com', requestId })).rejects.toThrow(msg);
      expect(s.signMessage).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });

  it('binds nothing for OIDC (no wallet signature)', async () => {
    // OIDC builds its payload from the token; the request id rule does not apply.
    expect(() => computeSignalHash({ scope: 'x', circuitId: 'oidc_domain_attestation', requestId: REQ })).toThrow(/has no signal_hash/);
  });
});
