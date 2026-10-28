/**
 * oidc_domain_attestation's provider-key statement (src/input/oidcStatement.ts)
 * and the prover side that consumes it (src/prover/oidcProver.ts,
 * src/prover/inputFormatter.ts).
 *
 * Edge-case matrix (drawn up before the code):
 *   contract   a modulus not in the provider's live key list is refused BEFORE
 *              signDigest is called; the live check is core's checkOidcProviderKey
 *              (fetch spied: Google and Microsoft `organizations` URLs)
 *   external   key-list fetch rejects / HTTP 500 / not JSON / no "keys" array /
 *              an expired cache whose refetch fails -> refused, never signed;
 *              KMS throws -> error; KMS signs with another key -> error
 *   hostile    Microsoft token whose key is only in Google's list (and the
 *              reverse) -> refused; a statement for another modulus, a
 *              malformed statement, signer_kind != 2, non-zero App Attest
 *              inputs -> refused by the prover
 *   boundary   modulus 255 / 256 / 257-with-leading-zero / 257 non-zero bytes,
 *              top bit clear, not base64url; now = iat, exp - 1 accepted,
 *              exp and iat - 1 refused; u64 overflow
 *   integrity  statement bytes equal circuits c970a4c's reference builder for
 *              fixed vectors; the signature verifies over SHA256(statement);
 *              a high-s KMS signature is normalised and still verifies;
 *              the statement's `now` is the prover's public `now`
 *   domain     magic / length differ from coinbase_attestation's statement
 *   empty      no statement / missing jwks keys -> refused
 *   UTF-8      N/A -- the statement is fixed-length binary built from numbers
 *              and the modulus; token claim parsing is unchanged and covered in
 *              oidcInputsV2.test.ts
 *   large      oversized payload refused before signing (proofRouteOidcStatement)
 *   race       N/A here (no shared state but core's key cache); the route test
 *              signs per request concurrently
 *   authz      N/A -- no caller identity; the device-client aud gate runs
 *              before signing (proofRouteOidcStatement)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { createPublicKey, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { p256 as nobleP256 } from '@noble/curves/p256';
import { clearOidcKeyCache } from '@zkproofport-app/core';
import {
  buildProviderKeyStatement,
  coreProviderKeyCheck,
  oidcCircuitTag,
  OIDC_STATEMENT_LEN,
  prepareOidcProviderKeyStatement,
  providerKeyModulusBytes,
} from '../src/input/oidcStatement.js';
import { signStatement, StatementRefusal, verifyRawP256, type StatementSigner } from '../src/input/statementSigner.js';
import { CLIENT_DATA_LEN } from '../src/input/coinbaseStatement.js';
import { oidcNowAt, prepareOidcCircuitInputs, type OidcProvePayload } from '../src/prover/oidcProver.js';
import { formatOidcInputs } from '../src/prover/inputFormatter.js';

const GOOGLE_DEVICE = '491923400813-pr17m6kpin2rsbbes18jpb60j1s3qmv4.apps.googleusercontent.com';
const MICROSOFT_CLIENT = '8b09c842-d7a8-4d9c-a6ea-46c797412bac';
const MS_ISS = 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const MICROSOFT_JWKS_URL = 'https://login.microsoftonline.com/organizations/discovery/v2.0/keys';
const MS_KEY_ISSUER = 'https://login.microsoftonline.com/{tenantid}/v2.0';
const CLOCK = 1_800_000_000;
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

// ─── fixtures ───────────────────────────────────────────────────────────

function rsaKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as { n: string; e: string; kty: string }), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk };
}
const googleKey = rsaKey('g1');
const microsoftKey = rsaKey('m1');

function signJwt(payload: Record<string, unknown>, key: ReturnType<typeof rsaKey>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: key.jwk.kid, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.${rsaSign('sha256', Buffer.from(`${header}.${body}`), key.privateKey).toString('base64url')}`;
}
const googleClaims = (extra: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com', aud: GOOGLE_DEVICE, sub: '1', email: 'alice@example.com',
  email_verified: true, hd: 'example.com', iat: CLOCK - 10, exp: CLOCK + 3590, ...extra,
});
const microsoftClaims = (extra: Record<string, unknown> = {}) => ({
  aud: MICROSOFT_CLIENT, iss: MS_ISS, iat: CLOCK - 10, exp: CLOCK + 3590, email: 'bob@contoso.com',
  xms_edov: true, tid: '72f988bf-86f1-41af-91ab-2d7cd011db47', ...extra,
});
const googlePayload = (claims = googleClaims()): OidcProvePayload =>
  ({ jwt: signJwt(claims, googleKey), jwks: { keys: [googleKey.jwk as never] }, scope: 'myapp:membership' });

function p256Key() {
  const privateKey = nobleP256.utils.randomPrivateKey();
  const pub = nobleP256.getPublicKey(privateKey, false);
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
  const pem = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(pub.slice(1, 33)), y: b64(pub.slice(33)) }, format: 'jwk' })
    .export({ format: 'pem', type: 'spki' }).toString();
  return { privateKey, pem };
}
const kmsKey = p256Key();

/** Signs like Cloud KMS: DER over a precomputed digest, no promise about s. */
function kmsLike(opts: { highS?: boolean; key?: ReturnType<typeof p256Key>; fail?: Error } = {}) {
  const key = opts.key ?? kmsKey;
  const signer = {
    signDigest: vi.fn(async (digest: Uint8Array) => {
      if (opts.fail) throw opts.fail;
      const sig = nobleP256.sign(digest, key.privateKey, { lowS: true });
      const out = opts.highS ? new nobleP256.Signature(sig.r, N - sig.s) : sig;
      return out.toDERRawBytes();
    }),
    publicKeyPem: vi.fn(async () => kmsKey.pem),
  };
  return signer satisfies StatementSigner;
}

/** A provider key list server: Google and Microsoft URLs, each with its own keys. */
function serveKeyLists(lists: Partial<Record<string, () => Promise<Response> | Response>>) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const handler = lists[String(url)];
    if (!handler) throw new Error(`unexpected fetch ${String(url)}`);
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const jwksResponse = (keys: unknown[], cacheControl = 'public, max-age=3600') =>
  () => new Response(JSON.stringify({ keys }), { status: 200, headers: { 'cache-control': cacheControl } });
const realLists = () => serveKeyLists({
  [GOOGLE_JWKS_URL]: jwksResponse([googleKey.jwk]),
  [MICROSOFT_JWKS_URL]: jwksResponse([{ ...microsoftKey.jwk, issuer: MS_KEY_ISSUER }]),
});

beforeEach(() => {
  clearOidcKeyCache();
  vi.spyOn(Date, 'now').mockReturnValue(CLOCK * 1000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── the statement bytes ────────────────────────────────────────────────

describe('the statement bytes', () => {
  // Computed with circuits c970a4c (branch oidc-signature),
  // oidc-domain-attestation/scripts/oidc-inputs.ts providerKeyStatement(), via tsx.
  // V2 is also the layout the circuit's own test `the_statement_layout` asserts.
  const n1 = new Uint8Array(256); n1[0] = 0xc0; for (let i = 1; i < 256; i++) n1[i] = i & 0xff;
  const n2 = new Uint8Array(256); n2[0] = 0x80; n2[254] = 0x01; n2[255] = 0x02;
  // Verbatim output of the reference builder (not reconstructed):
  const V1 =
    '5a4b50726f6f66706f72742f504b2f3190bb379df4b0dde794c16917c2df39a398dc7e3481b2f50d031dfe490a8e062b00000000006b49d200c00102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a' +
    '2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e' +
    '8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';
  const V2 =
    '5a4b50726f6f66706f72742f504b2f3190bb379df4b0dde794c16917c2df39a398dc7e3481b2f50d031dfe490a8e062b01010203040506070880000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000102';

  it('matches the reference builder (Google, now 1800000000)', () => {
    expect(ethers.hexlify(buildProviderKeyStatement(0, 1_800_000_000n, n1))).toBe('0x' + V1);
  });
  it('matches the reference builder (Microsoft, now 0x0102030405060708, n = 2^2047 + 0x0102)', () => {
    expect(ethers.hexlify(buildProviderKeyStatement(1, 0x0102030405060708n, n2))).toBe('0x' + V2);
  });
  it('a JWKS n with a leading zero byte gives the same statement as without (reference: same hex)', () => {
    const lead = new Uint8Array(257); lead.set(n1, 1);
    const m = providerKeyModulusBytes(Buffer.from(lead).toString('base64url'));
    expect(ethers.hexlify(buildProviderKeyStatement(0, 1_800_000_000n, m))).toBe('0x' + V1);
  });
  it('is 313 bytes with the PK magic and the circuit tag, not the Coinbase statement', () => {
    const s = buildProviderKeyStatement(0, 1n, n1);
    expect(s.length).toBe(OIDC_STATEMENT_LEN);
    expect(OIDC_STATEMENT_LEN).not.toBe(CLIENT_DATA_LEN);
    expect(Buffer.from(s.slice(0, 16)).toString('ascii')).toBe('ZKProofport/PK/1');
    expect(ethers.hexlify(oidcCircuitTag())).toBe('0x90bb379df4b0dde794c16917c2df39a398dc7e3481b2f50d031dfe490a8e062b');
  });
  it.each([[2], [-1], [255]])('refuses provider value %i', (p) => {
    expect(() => buildProviderKeyStatement(p, 1n, n1)).toThrow(/Unknown OIDC provider value/);
  });
  it('refuses a now outside u64', () => {
    expect(() => buildProviderKeyStatement(0, 1n << 64n, n1)).toThrow(/u64/);
    expect(() => buildProviderKeyStatement(0, -1n, n1)).toThrow(/u64/);
    expect(ethers.hexlify(buildProviderKeyStatement(0, (1n << 64n) - 1n, n1).slice(49, 57))).toBe('0xffffffffffffffff');
  });
});

describe('the modulus', () => {
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
  const top = (len: number, first = 0x80) => { const b = new Uint8Array(len); b[0] = first; b[len - 1] = 1; return b; };

  it('takes 256 bytes with the top bit set', () => {
    expect(providerKeyModulusBytes(b64(top(256))).length).toBe(256);
  });
  it.each([
    ['255 bytes', b64(top(255))],
    ['256 bytes with the top bit clear (a 2047-bit key)', b64(top(256, 0x40))],
    ['257 non-zero bytes (wider than 2048 bits)', b64(top(257))],
    ['a 1024-bit key', b64(top(128))],
    ['standard base64 with padding', Buffer.from(top(256)).toString('base64')],
    ['an empty string', ''],
    ['not a string', 12345],
    ['a <script> tag', '<script>'],
  ])('refuses %s', (_n, value) => {
    expect(() => providerKeyModulusBytes(value)).toThrow(StatementRefusal);
    try { providerKeyModulusBytes(value); } catch (e) { expect((e as StatementRefusal).code).toBe('OIDC_PROVIDER_KEY_INVALID'); }
  });
  it('drops any number of leading zero bytes', () => {
    const lead = new Uint8Array(260); lead.set(top(256), 4);
    expect(ethers.hexlify(providerKeyModulusBytes(b64(lead)))).toBe(ethers.hexlify(top(256)));
  });
});

// ─── signing ────────────────────────────────────────────────────────────

describe('signStatement', () => {
  const msg = buildProviderKeyStatement(0, 5n, (() => { const b = new Uint8Array(256); b[0] = 0x80; return b; })());

  it('signs SHA256(statement) and returns r || s that verifies', async () => {
    const signer = kmsLike();
    const sig = await signStatement(signer, msg);
    expect(sig.length).toBe(64);
    expect(ethers.hexlify(signer.signDigest.mock.calls[0][0] as Uint8Array)).toBe(ethers.sha256(msg));
    expect(await verifyRawP256(kmsKey.pem, msg, sig)).toBe(true);
  });
  it('normalises a high-s KMS signature to low s, and it still verifies', async () => {
    const sig = await signStatement(kmsLike({ highS: true }), msg);
    const s = BigInt(ethers.hexlify(sig.slice(32)));
    expect(s <= N >> 1n).toBe(true);
    expect(await verifyRawP256(kmsKey.pem, msg, sig)).toBe(true);
  });
  it('refuses a signature made by another key', async () => {
    await expect(signStatement(kmsLike({ key: p256Key() }), msg)).rejects.toThrow(/does not verify/);
  });
  it('passes a KMS error through', async () => {
    await expect(signStatement(kmsLike({ fail: new Error('PERMISSION_DENIED') }), msg)).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

// ─── the live key check (core) ──────────────────────────────────────────

describe('prepareOidcProviderKeyStatement with core\'s live key check', () => {
  it('Google: fetches Google\'s list, signs (provider 0, now, n) for the clock', async () => {
    const fetchMock = realLists();
    const signer = kmsLike();
    const st = await prepareOidcProviderKeyStatement(googlePayload(), { signer });
    expect(fetchMock).toHaveBeenCalledWith(GOOGLE_JWKS_URL, expect.objectContaining({ redirect: 'error' }));
    expect(st.now).toBe(String(CLOCK));
    expect(st.modulus).toBe('0x' + Buffer.from(googleKey.jwk.n, 'base64url').toString('hex'));
    const statement = buildProviderKeyStatement(0, BigInt(st.now), ethers.getBytes(st.modulus));
    expect(await verifyRawP256(kmsKey.pem, statement, ethers.getBytes(st.signature))).toBe(true);
  });

  it('Microsoft: fetches the organizations list, provider 1', async () => {
    const fetchMock = realLists();
    const payload: OidcProvePayload = { jwt: signJwt(microsoftClaims(), microsoftKey), jwks: { keys: [microsoftKey.jwk as never] }, scope: 's' };
    const st = await prepareOidcProviderKeyStatement(payload, { signer: kmsLike() });
    expect(fetchMock).toHaveBeenCalledWith(MICROSOFT_JWKS_URL, expect.anything());
    const statement = buildProviderKeyStatement(1, BigInt(st.now), ethers.getBytes(st.modulus));
    expect(await verifyRawP256(kmsKey.pem, statement, ethers.getBytes(st.signature))).toBe(true);
  });

  it('uses the skew-adjusted now: a token issued 30 s ahead of the clock signs at its iat', async () => {
    realLists();
    const st = await prepareOidcProviderKeyStatement(googlePayload(googleClaims({ iat: CLOCK + 30 })), { signer: kmsLike() });
    expect(st.now).toBe(String(CLOCK + 30));
  });

  async function refusal(p: Promise<unknown>): Promise<StatementRefusal> {
    const e = await p.then(() => { throw new Error('expected a refusal'); }, (x: unknown) => x);
    expect(e).toBeInstanceOf(StatementRefusal);
    return e as StatementRefusal;
  }

  it('refuses a self-made key (not in Google\'s list) without signing', async () => {
    serveKeyLists({ [GOOGLE_JWKS_URL]: jwksResponse([rsaKey('other').jwk]) });
    const signer = kmsLike();
    const e = await refusal(prepareOidcProviderKeyStatement(googlePayload(), { signer }));
    expect(e.code).toBe('OIDC_PROVIDER_KEY_UNPUBLISHED');
    expect(signer.signDigest).not.toHaveBeenCalled();
  });

  it('refuses a Microsoft token whose key is only in Google\'s list', async () => {
    serveKeyLists({
      [GOOGLE_JWKS_URL]: jwksResponse([googleKey.jwk]),
      [MICROSOFT_JWKS_URL]: jwksResponse([{ ...microsoftKey.jwk, issuer: MS_KEY_ISSUER }]),
    });
    const signer = kmsLike();
    const forged: OidcProvePayload = { jwt: signJwt(microsoftClaims(), { ...googleKey, jwk: { ...googleKey.jwk, kid: 'g1' } }), jwks: { keys: [googleKey.jwk as never] }, scope: 's' };
    const e = await refusal(prepareOidcProviderKeyStatement(forged, { signer }));
    expect(e.code).toBe('OIDC_PROVIDER_KEY_UNPUBLISHED');
    expect(signer.signDigest).not.toHaveBeenCalled();
  });

  it('refuses a Google token whose key is only in Microsoft\'s list', async () => {
    serveKeyLists({
      [GOOGLE_JWKS_URL]: jwksResponse([]),
      [MICROSOFT_JWKS_URL]: jwksResponse([{ ...googleKey.jwk, issuer: MS_KEY_ISSUER }]),
    });
    const e = await refusal(prepareOidcProviderKeyStatement(googlePayload(), { signer: kmsLike() }));
    expect(e.code).toBe('OIDC_PROVIDER_KEY_UNPUBLISHED');
  });

  it.each([
    ['the fetch rejects', () => Promise.reject(new TypeError('fetch failed'))],
    ['HTTP 500', () => new Response('oops', { status: 500 })],
    ['HTTP 404', () => new Response('', { status: 404 })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['JSON without a keys array', () => new Response(JSON.stringify({ kid: 'x' }), { status: 200 })],
    ['keys that are not an array', () => new Response(JSON.stringify({ keys: { n: 'x' } }), { status: 200 })],
  ])('refuses when %s, without signing', async (_n, handler) => {
    serveKeyLists({ [GOOGLE_JWKS_URL]: handler });
    const signer = kmsLike();
    const e = await refusal(prepareOidcProviderKeyStatement(googlePayload(), { signer }));
    expect(e.code).toBe('OIDC_PROVIDER_KEY_UNPUBLISHED');
    expect(signer.signDigest).not.toHaveBeenCalled();
  });

  it('never signs from an expired cache whose refetch fails', async () => {
    let up = true;
    serveKeyLists({ [GOOGLE_JWKS_URL]: () => (up ? jwksResponse([googleKey.jwk], 'max-age=60')() : Promise.reject(new TypeError('fetch failed'))) });
    await prepareOidcProviderKeyStatement(googlePayload(), { signer: kmsLike() });
    up = false;
    vi.spyOn(Date, 'now').mockReturnValue((CLOCK + 61) * 1000);
    const signer = kmsLike();
    const e = await refusal(prepareOidcProviderKeyStatement(googlePayload(googleClaims({ iat: CLOCK + 50 })), { signer, now: () => (CLOCK + 61) * 1000 }));
    expect(e.code).toBe('OIDC_PROVIDER_KEY_UNPUBLISHED');
    expect(signer.signDigest).not.toHaveBeenCalled();
  });

  it('a key dropped from a successful refetch is still accepted within core\'s 24 h retention (verifiers accept it too)', async () => {
    let keys: unknown[] = [googleKey.jwk];
    serveKeyLists({ [GOOGLE_JWKS_URL]: () => jwksResponse(keys, 'max-age=60')() });
    await prepareOidcProviderKeyStatement(googlePayload(), { signer: kmsLike() });
    keys = [];
    const later = (CLOCK + 120) * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const st = await prepareOidcProviderKeyStatement(googlePayload(googleClaims({ iat: CLOCK + 100 })), { signer: kmsLike(), now: () => later });
    expect(st.now).toBe(String(CLOCK + 120));
  });

  it('refuses a key the provider lists with another exponent or algorithm (core\'s rules)', async () => {
    serveKeyLists({ [GOOGLE_JWKS_URL]: jwksResponse([{ ...googleKey.jwk, alg: 'RS512' }]) });
    const e = await refusal(prepareOidcProviderKeyStatement(googlePayload(), { signer: kmsLike() }));
    expect(e.code).toBe('OIDC_PROVIDER_KEY_UNPUBLISHED');
  });

  it('refuses a 1024-bit key as invalid before any fetch', async () => {
    const fetchMock = realLists();
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const jwk = { ...(small.publicKey.export({ format: 'jwk' }) as { n: string }), kid: 'g1', kty: 'RSA' };
    const payload: OidcProvePayload = { jwt: signJwt(googleClaims(), { privateKey: small.privateKey, jwk: jwk as never }), jwks: { keys: [jwk as never] }, scope: 's' };
    const e = await refusal(prepareOidcProviderKeyStatement(payload, { signer: kmsLike() }));
    expect(e.code).toBe('OIDC_PROVIDER_KEY_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a foreign audience', googleClaims({ aud: '123-other.apps.googleusercontent.com' })],
    ['an expired token', googleClaims({ exp: CLOCK })],
    ['a token issued 61 s ahead', googleClaims({ iat: CLOCK + 61 })],
    ['an unverified email', googleClaims({ email_verified: false })],
  ])('refuses %s as OIDC_TOKEN_REFUSED before any fetch', async (_n, claims) => {
    const fetchMock = realLists();
    const e = await refusal(prepareOidcProviderKeyStatement(googlePayload(claims), { signer: kmsLike() }));
    expect(e.code).toBe('OIDC_TOKEN_REFUSED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['jwks without keys', { jwks: {} }],
    ['jwks as a string', { jwks: 'keys' }],
    ['a kid the jwks does not hold', { jwks: { keys: [{ ...googleKey.jwk, kid: 'zz' }] } }],
  ])('refuses %s as OIDC_TOKEN_REFUSED', async (_n, patch) => {
    realLists();
    const e = await refusal(prepareOidcProviderKeyStatement({ ...googlePayload(), ...patch } as never, { signer: kmsLike() }));
    expect(e.code).toBe('OIDC_TOKEN_REFUSED');
  });

  it('a KMS failure is an error (not a refusal) and nothing is returned', async () => {
    realLists();
    await expect(prepareOidcProviderKeyStatement(googlePayload(), { signer: kmsLike({ fail: new Error('UNAVAILABLE') }) })).rejects.toThrow(/UNAVAILABLE/);
  });

  it('a KMS signature by another key is an error', async () => {
    realLists();
    await expect(prepareOidcProviderKeyStatement(googlePayload(), { signer: kmsLike({ key: p256Key() }) })).rejects.toThrow(/does not verify/);
  });

  it('coreProviderKeyCheck packs the modulus the way core reads it (exact match only)', async () => {
    realLists();
    const n = providerKeyModulusBytes(googleKey.jwk.n);
    expect(await coreProviderKeyCheck(0, n)).toEqual({ ok: true });
    const flipped = n.slice(); flipped[255] ^= 1;
    expect((await coreProviderKeyCheck(0, flipped)).ok).toBe(false);
  });
});

// ─── the prover side ────────────────────────────────────────────────────

describe('the prover with a signed statement', () => {
  const sig = '0x' + '22'.repeat(64);
  const modulus = '0x' + Buffer.from(googleKey.jwk.n, 'base64url').toString('hex');
  const withStatement = (st: Record<string, unknown>, claims = googleClaims()) =>
    ({ ...googlePayload(claims), providerKeyStatement: { now: String(CLOCK), modulus, signature: sig, ...st } }) as OidcProvePayload;

  it('uses the signed now as the public now, and fills the ten signer inputs as the server kind', () => {
    vi.spyOn(Date, 'now').mockReturnValue((CLOCK + 500) * 1000); // the prover's clock is not consulted
    const out = prepareOidcCircuitInputs(withStatement({}));
    expect(out.now).toBe(String(CLOCK));
    expect(out.nonce_mode).toBe(0);
    expect(out.nonce_binding).toEqual(new Array(32).fill(0));
    expect(out.signer_kind).toBe(2);
    expect(ethers.hexlify(Uint8Array.from(out.statement_sig))).toBe(sig);
    expect([out.credential_tbs.length, out.credential_sig.length, out.att_auth_data.length, out.att_client_data_hash.length, out.assertion_auth_data.length])
      .toEqual([1000, 96, 256, 32, 128]);
    expect([out.credential_tbs_len, out.att_auth_data_len, out.assertion_auth_data_len]).toEqual([0, 0, 0]);
    const f = formatOidcInputs(out);
    expect(f.signer_kind).toBe('2');
    expect((f.statement_sig as string[]).length).toBe(64);
    expect(f.credential_tbs_len).toBe('0');
    expect((f.credential_tbs as string[]).every(b => b === '0x00')).toBe(true);
  });

  it('accepts now = iat and now = exp - 1, refuses now = exp and now = iat - 1', () => {
    const claims = googleClaims({ iat: CLOCK - 10, exp: CLOCK + 100 });
    expect(prepareOidcCircuitInputs(withStatement({ now: String(CLOCK - 10) }, claims)).now).toBe(String(CLOCK - 10));
    expect(prepareOidcCircuitInputs(withStatement({ now: String(CLOCK + 99) }, claims)).now).toBe(String(CLOCK + 99));
    expect(() => prepareOidcCircuitInputs(withStatement({ now: String(CLOCK + 100) }, claims))).toThrow(/expired/);
    expect(() => prepareOidcCircuitInputs(withStatement({ now: String(CLOCK - 11) }, claims))).toThrow(/before the JWT iat/);
    expect(() => oidcNowAt('1', 2, 1n)).toThrow(/iat must be/);
  });

  it('refuses a statement signed for another modulus', () => {
    const other = '0x' + Buffer.from(rsaKey('x').jwk.n, 'base64url').toString('hex');
    expect(() => prepareOidcCircuitInputs(withStatement({ modulus: other }))).toThrow(/different RSA key/);
  });

  it.each([
    ['no statement', undefined],
    ['now not decimal', { now: '0x10' }],
    ['now with a leading zero', { now: '01' }],
    ['now past u64', { now: (1n << 64n).toString() }],
    ['now as a number', { now: CLOCK }],
    ['modulus 255 bytes', { modulus: '0x' + 'ab'.repeat(255) }],
    ['signature 63 bytes', { signature: '0x' + '22'.repeat(63) }],
    ['signature not hex', { signature: '0x' + 'zz'.repeat(64) }],
  ])('refuses %s', (_n, st) => {
    const payload = st === undefined ? googlePayload() : withStatement(st as Record<string, unknown>);
    expect(() => prepareOidcCircuitInputs(payload)).toThrow(/providerKeyStatement|provider-key statement/);
  });

  it('the formatter refuses any signer kind but the server\'s, and non-zero App Attest inputs', () => {
    const out = prepareOidcCircuitInputs(withStatement({}));
    expect(() => formatOidcInputs({ ...out, signer_kind: 1 })).toThrow(/signer_kind must be 2/);
    expect(() => formatOidcInputs({ ...out, credential_tbs_len: 5 })).toThrow(/credential_tbs must be 1000 zero bytes/);
    const tbs = out.credential_tbs.slice(); tbs[3] = 1;
    expect(() => formatOidcInputs({ ...out, credential_tbs: tbs })).toThrow(/credential_tbs/);
    expect(() => formatOidcInputs({ ...out, att_client_data_hash: new Array(31).fill(0) })).toThrow(/att_client_data_hash/);
    expect(() => formatOidcInputs({ ...out, statement_sig: new Array(65).fill(0) })).toThrow(/statement_sig is 65 bytes/);
  });
});
