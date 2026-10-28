/**
 * POST /api/v1/prove for oidc_domain_attestation: the server validates the
 * token, confirms its RSA key is in the provider's live key list and signs
 * the provider-key statement BEFORE it settles any payment; refusals are free;
 * the prover gets the statement the server signed and nothing a caller sent.
 *
 * Matrix rows covered here (the module's own rows are in oidcStatement.test.ts):
 *   contract   checkProviderKey + signer called for OIDC only; order is
 *              check -> sign -> settle -> prove
 *   order      every refusal (unpublished key, key-list failure, bad token,
 *              invalid key, KMS error, wrong-key signature) settles nothing
 *   hostile    a caller-sent providerKeyStatement is overwritten; a forged
 *              signer kind cannot be sent (the prover only builds kind 2)
 *   empty      missing jwt / jwks / scope -> 400 before checking anything;
 *              routes built without a signer answer 500, never prove
 *   large      a payload past the 2048-byte cap -> 400 before payment
 *   authz      a foreign audience (not the device client) -> 400 before payment
 *   integrity  the prover's public `now` equals the signed `now`, nonce_mode 0
 *              (device flow unchanged) and the signature verifies over the
 *              statement the circuit rebuilds
 *   race       concurrent requests each get their own statement
 *   logs       neither the raw token nor the email reaches any log line
 *   E2E-encrypted OIDC payload refused
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { createPublicKey, generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { p256 as nobleP256 } from '@noble/curves/p256';

const calls = vi.hoisted(() => [] as string[]);
const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../src/logger.js', () => {
  const make = (component: string): Record<string, unknown> => {
    const rec = (level: string) => (...args: unknown[]) => { logLines.push(JSON.stringify({ level, component, args }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Error ? { message: v.message, stack: v.stack } : v))); };
    return { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug'), child: () => make(component) };
  };
  return { logger: make('root'), createLogger: make };
});
const prove = vi.hoisted(() => vi.fn(async () => { calls.push('prove'); return { proof: '0x11', publicInputs: '0x22', proofWithInputs: '0x1122' }; }));
vi.mock('../src/prover/bbProver.js', () => ({ BbProver: class { prove = prove; } }));
const settle = vi.hoisted(() => vi.fn(async () => { calls.push('settle'); return { txHash: '0x' + 'ab'.repeat(32), via: 'test' }; }));
vi.mock('../src/payment/settle.js', () => ({ settlePayment: settle }));
const verifyPayment = vi.hoisted(() => vi.fn(async () => ({ valid: true })));
vi.mock('../src/proof/paymentVerifier.js', () => ({ verifyPaymentOnChain: verifyPayment }));

import { createProofRoutes } from '../src/proof/proofRoutes.js';
import { buildProviderKeyStatement, type ProviderKeyCheck } from '../src/input/oidcStatement.js';
import { verifyRawP256, type StatementSigner } from '../src/input/statementSigner.js';
import { prepareOidcCircuitInputs, type OidcProvePayload } from '../src/prover/oidcProver.js';
import type { AttestationReader } from '../src/input/coinbaseStatement.js';
import type { Config } from '../src/config/index.js';

const GOOGLE_DEVICE = '491923400813-pr17m6kpin2rsbbes18jpb60j1s3qmv4.apps.googleusercontent.com';
const EMAIL = 'alice.private@example.com';

const { privateKey: rsaPriv, publicKey: rsaPub } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(rsaPub.export({ format: 'jwk' }) as { n: string; e: string; kty: string }), kid: 'g1', alg: 'RS256', use: 'sig' };
const MODULUS = '0x' + Buffer.from(jwk.n, 'base64url').toString('hex');

function signJwt(extra: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://accounts.google.com', aud: GOOGLE_DEVICE, sub: '1', email: EMAIL,
    email_verified: true, hd: 'example.com', iat: now - 10, exp: now + 3590, ...extra,
  };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'g1', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${body}.${rsaSign('sha256', Buffer.from(`${header}.${body}`), rsaPriv).toString('base64url')}`;
}
const oidcInputs = (extra: Record<string, unknown> = {}) => ({ jwt: signJwt(), jwks: { keys: [jwk] }, scope: 'myapp:membership', provider: 'google', ...extra });

const kmsPriv = nobleP256.utils.randomPrivateKey();
const kmsPub = nobleP256.getPublicKey(kmsPriv, false);
const PEM = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(kmsPub.slice(1, 33)).toString('base64url'), y: Buffer.from(kmsPub.slice(33)).toString('base64url') }, format: 'jwk' })
  .export({ format: 'pem', type: 'spki' }).toString();

function deps(opts: { published?: boolean | 'fetch-failed'; signWith?: Uint8Array; kmsError?: Error } = {}) {
  const reader = { latestUid: vi.fn(), onChain: vi.fn() } as unknown as AttestationReader & { latestUid: ReturnType<typeof vi.fn> };
  const signer: StatementSigner & { signDigest: ReturnType<typeof vi.fn> } = {
    signDigest: vi.fn(async (d: Uint8Array) => {
      calls.push('sign');
      if (opts.kmsError) throw opts.kmsError;
      return nobleP256.sign(d, opts.signWith ?? kmsPriv, { lowS: false }).toDERRawBytes();
    }),
    publicKeyPem: async () => PEM,
  };
  const checkProviderKey = vi.fn<ProviderKeyCheck>(async (provider, modulus) => {
    calls.push('check');
    if (opts.published === 'fetch-failed') return { ok: false, error: "Could not fetch Google's signing keys from https://www.googleapis.com/oauth2/v3/certs: HTTP 503" };
    if (opts.published === false) return { ok: false, error: 'The proof was made with an RSA key that Google does not publish' };
    expect(provider).toBe(0);
    expect(ethers.hexlify(modulus)).toBe(MODULUS);
    return { ok: true };
  });
  return { reader, signer, checkProviderKey };
}

const baseConfig = {
  paymentMode: 'disabled', paymentNetworks: 'base-sepolia', paymentProofPrice: '$0.10', paymentPayTo: '0x' + '11'.repeat(20),
  teeMode: 'local', chainRpcUrl: 'https://sepolia.base.org', a2aBaseUrl: 'https://proof.example.com',
} as Config;

function app(config: Config, statement?: ReturnType<typeof deps>) {
  const a = express();
  a.use(express.json({ limit: '1mb' }));
  a.use('/api/v1', createProofRoutes({ config, redis: { getdel: async () => 'oidc_domain_attestation' } as never, ...(statement ? { statement } : {}) }));
  return a;
}
const paid = (r: request.Test) => r
  .set('X-Payment-Nonce', 'n')
  .set('PAYMENT-SIGNATURE', Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: 'eip155:84532' }, payload: {} })).toString('base64'));
const paidApp = (d?: ReturnType<typeof deps>) => app({ ...baseConfig, paymentMode: 'testnet' }, d);

beforeEach(() => {
  calls.length = 0;
  logLines.length = 0;
  prove.mockClear(); settle.mockClear(); verifyPayment.mockClear();
});

describe('oidc_domain_attestation provider-key statement in the proof route', () => {
  it('checks the key, signs, then settles and proves with the signed statement', async () => {
    const d = deps();
    const res = await paid(request(paidApp(d)).post('/api/v1/prove')).send({ circuit: 'oidc_domain', inputs: oidcInputs() });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['check', 'sign', 'settle', 'prove']);
    expect(d.reader.latestUid).not.toHaveBeenCalled();

    const sent = prove.mock.calls[0][1] as OidcProvePayload;
    expect(sent.providerKeyStatement!.modulus).toBe(MODULUS);
    // The prover's public `now` is the signed `now`; the device flow is still nonce_mode 0.
    const built = prepareOidcCircuitInputs(sent);
    expect(built.now).toBe(sent.providerKeyStatement!.now);
    expect(built.nonce_mode).toBe(0);
    expect(built.signer_kind).toBe(2);
    // The signature verifies over the statement the circuit rebuilds from its public inputs.
    const statement = buildProviderKeyStatement(built.provider, BigInt(built.now), ethers.getBytes(MODULUS));
    expect(await verifyRawP256(PEM, statement, Uint8Array.from(built.statement_sig))).toBe(true);
    expect(BigInt(ethers.hexlify(Uint8Array.from(built.statement_sig.slice(32)))) <= BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551') >> 1n).toBe(true);
  });

  it('overwrites a caller-sent providerKeyStatement', async () => {
    const forged = { now: '1', modulus: '0x' + 'ff'.repeat(256), signature: '0x' + '01'.repeat(64) };
    const res = await request(app(baseConfig, deps())).post('/api/v1/prove').set('X-Payment-Nonce', 'n')
      .send({ circuit: 'oidc_domain_attestation', inputs: oidcInputs({ providerKeyStatement: forged }) });
    expect(res.status).toBe(200);
    const sent = prove.mock.calls[0][1] as OidcProvePayload;
    expect(sent.providerKeyStatement).not.toEqual(forged);
    expect(sent.providerKeyStatement!.modulus).toBe(MODULUS);
  });

  it.each([
    ['an unpublished key', { published: false as const }, 403, 'OIDC_PROVIDER_KEY_UNPUBLISHED'],
    ['a key list that cannot be fetched', { published: 'fetch-failed' as const }, 403, 'OIDC_PROVIDER_KEY_UNPUBLISHED'],
  ])('settles nothing and signs nothing for %s', async (_n, opts, status, code) => {
    const d = deps(opts);
    const res = await paid(request(paidApp(d)).post('/api/v1/prove')).send({ circuit: 'oidc_domain', inputs: oidcInputs() });
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
    expect(d.signer.signDigest).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });

  it.each([
    ['a KMS error', { kmsError: new Error('PERMISSION_DENIED on cryptoKeyVersions.useToSign') }, /PERMISSION_DENIED/],
    ['a signature by another key', { signWith: nobleP256.utils.randomPrivateKey() }, /does not verify/],
  ])('answers 500 and settles nothing for %s', async (_n, opts, message) => {
    const res = await paid(request(paidApp(deps(opts))).post('/api/v1/prove')).send({ circuit: 'oidc_domain', inputs: oidcInputs() });
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(message);
    expect(settle).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });

  it.each([
    ['a foreign audience', { jwt: signJwt({ aud: '123-other.apps.googleusercontent.com' }) }, 'OIDC_TOKEN_REFUSED'],
    ['an expired token', { jwt: signJwt({ exp: Math.floor(Date.now() / 1000) - 1, iat: Math.floor(Date.now() / 1000) - 100 }) }, 'OIDC_TOKEN_REFUSED'],
    ['a payload past 2048 bytes', { jwt: signJwt({ pad: 'x'.repeat(2100) }) }, 'OIDC_TOKEN_REFUSED'],
    ['a provider that disagrees with iss', { provider: 'microsoft' }, 'OIDC_TOKEN_REFUSED'],
    ['a jwt that is not three parts', { jwt: 'a.b' }, 'OIDC_TOKEN_REFUSED'],
    ['a 1024-bit key', (() => {
      const small = generateKeyPairSync('rsa', { modulusLength: 1024 });
      const k = { ...(small.publicKey.export({ format: 'jwk' }) as object), kid: 'g1' };
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'g1', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: GOOGLE_DEVICE, email: EMAIL, email_verified: true, hd: 'example.com', iat: now - 1, exp: now + 100 })).toString('base64url');
      return { jwt: `${header}.${body}.${rsaSign('sha256', Buffer.from(`${header}.${body}`), small.privateKey).toString('base64url')}`, jwks: { keys: [k] } };
    })(), 'OIDC_PROVIDER_KEY_INVALID'],
  ])('refuses %s with 400 before checking keys or settling', async (_n, patch, code) => {
    const d = deps();
    const res = await paid(request(paidApp(d)).post('/api/v1/prove')).send({ circuit: 'oidc_domain', inputs: oidcInputs(patch) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(code);
    expect(d.checkProviderKey).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it.each([
    ['jwt', { jwt: undefined }], ['jwt', { jwt: '' }], ['jwt', { jwt: 7 }],
    ['jwks', { jwks: undefined }], ['jwks', { jwks: 'keys' }],
    ['scope', { scope: undefined }], ['scope', { scope: '' }],
  ])('refuses a missing or malformed %s with 400 before anything else', async (_f, patch) => {
    const d = deps();
    const res = await paid(request(paidApp(d)).post('/api/v1/prove')).send({ circuit: 'oidc_domain', inputs: oidcInputs(patch) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
    expect(d.checkProviderKey).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('refuses an E2E-encrypted OIDC payload: the server cannot check a key it cannot read', async () => {
    const d = deps();
    const res = await request(app({ ...baseConfig, teeMode: 'nitro' }, d)).post('/api/v1/prove').set('X-Payment-Nonce', 'n')
      .send({ circuit: 'oidc_domain_attestation', encrypted_payload: { keyId: 'k' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('E2E_UNSUPPORTED');
    expect(d.signer.signDigest).not.toHaveBeenCalled();
  });

  it('never proves an OIDC request on routes built without a signer', async () => {
    const res = await request(app(baseConfig)).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: 'oidc_domain', inputs: oidcInputs() });
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/statement signer is not configured/);
    expect(prove).not.toHaveBeenCalled();
  });

  it('signs a fresh statement per request under concurrency', async () => {
    const d = deps();
    const a = app(baseConfig, d);
    const [r1, r2] = await Promise.all([
      request(a).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: 'oidc_domain', inputs: oidcInputs() }),
      request(a).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: 'oidc_domain', inputs: oidcInputs({ scope: 'other' }) }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(d.signer.signDigest).toHaveBeenCalledTimes(2);
    for (const c of prove.mock.calls) prepareOidcCircuitInputs(c[1] as OidcProvePayload);
  });

  it('logs neither the raw token nor the email, on success or refusal', async () => {
    const jwt = signJwt();
    await request(app(baseConfig, deps())).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: 'oidc_domain', inputs: oidcInputs({ jwt }) });
    const badEmail = signJwt({ email: 'no-at-sign-private', aud: GOOGLE_DEVICE });
    await request(app(baseConfig, deps())).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: 'oidc_domain', inputs: oidcInputs({ jwt: badEmail }) });
    await request(app(baseConfig, deps({ published: false }))).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: 'oidc_domain', inputs: oidcInputs({ jwt }) });
    const all = logLines.join('\n');
    expect(logLines.some(l => l.includes('oidc.statement.signed'))).toBe(true);
    expect(logLines.some(l => l.includes('prove.oidc.statement_refused'))).toBe(true);
    for (const secret of [jwt, jwt.split('.')[1], jwt.split('.')[2], badEmail.split('.')[1], EMAIL, 'no-at-sign-private']) {
      expect(all).not.toContain(secret);
    }
  });

  it('does not run the OIDC check for a Coinbase country request', async () => {
    const d = deps();
    const a = express();
    a.use(express.json());
    a.use('/api/v1', createProofRoutes({ config: baseConfig, redis: { getdel: async () => 'coinbase_country_attestation' } as never, statement: d }));
    await request(a).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: 'coinbase_country_attestation', inputs: {} });
    expect(d.checkProviderKey).not.toHaveBeenCalled();
    expect(d.signer.signDigest).not.toHaveBeenCalled();
  });
});
