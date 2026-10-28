/**
 * OIDC v2 input builders: the server's (src/prover/oidcProver.ts, runs in the
 * prover) and the client SDK's (packages/sdk/src/oidc-inputs.ts).
 *
 * The v2 circuit (214 public inputs) binds aud, iss and iat <= now < exp. This
 * server proves for the device flow, so it must prove in nonce_mode 0 with a
 * zero binding and accept only the device-flow clients' tokens -- a token for
 * any other client would give a proof every ZKProofport verifier refuses.
 *
 * Matrix: audience (device ok per provider; app web client, foreign, missing,
 * array, empty refused), issuer (both Google spellings, Microsoft v2 tenant;
 * v1, uppercase tenant, unknown, non-string refused), provider (agrees,
 * disagrees, unknown, omitted -> from iss), time (exp boundary, iat ahead by
 * 60 / 61 s, non-integer claims), the SHA cut and decode offset at header
 * lengths below, at and past 64, the 2048-byte cap at and past it, the new
 * public fields, the noir_js formatting, and that the SDK and server tables and
 * outputs agree. Circuit acceptance is checked separately by
 * scripts/check-oidc-inputs.ts against the compiled v2 circuit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign, createHash, type KeyObject } from 'crypto';
import { ethers } from 'ethers';
import {
  prepareOidcCircuitInputs as proverBuild,
  oidcStatementSubject,
  resolveOidcProvider,
  oidcNowFor,
  OIDC_PROVIDERS,
  OIDC_MAX_PARTIAL_DATA_LENGTH,
  OIDC_IAT_CLOCK_SKEW_SECONDS,
} from '../src/prover/oidcProver.js';
import { formatOidcInputs, type OidcCircuitInputs } from '../src/prover/inputFormatter.js';
import type { OidcProvePayload } from '../src/prover/oidcProver.js';
import {
  checkDeviceFlowToken,
  prepareOidcInputs,
  prepareOidcPayload,
  OIDC_DEVICE_PROVIDERS,
  OIDC_MAX_PARTIAL_DATA_LENGTH as SDK_MAX_PARTIAL,
} from '../packages/sdk/src/oidc-inputs.js';

const GOOGLE_DEVICE = '491923400813-pr17m6kpin2rsbbes18jpb60j1s3qmv4.apps.googleusercontent.com';
const GOOGLE_WEB = '491923400813-5bb3up7dhejns2unvbrt6mku520hrr5g.apps.googleusercontent.com';
const MICROSOFT = '8b09c842-d7a8-4d9c-a6ea-46c797412bac';
const MS_ISS = 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0';
const CLOCK = 1_800_000_000;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'k1', alg: 'RS256', use: 'sig' };

function signJwt(payload: Record<string, unknown> | string, kid = 'k1', key: KeyObject = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64url');
  const sig = sign('sha256', Buffer.from(`${header}.${body}`), key);
  return `${header}.${body}.${sig.toString('base64url')}`;
}

const google = (extra: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com', aud: GOOGLE_DEVICE, sub: '1', email: 'alice@example.com',
  email_verified: true, hd: 'example.com', iat: CLOCK - 10, exp: CLOCK + 3590, ...extra,
});
const microsoft = (extra: Record<string, unknown> = {}) => ({
  aud: MICROSOFT, iss: MS_ISS, iat: CLOCK - 10, nbf: CLOCK - 10, exp: CLOCK + 3590, email: 'bob@contoso.com',
  xms_edov: true, tid: '72f988bf-86f1-41af-91ab-2d7cd011db47', ...extra,
});

/**
 * The server's two steps for one token, as the route runs them: the subject
 * (validated against the clock, before payment) and then the prover with the
 * statement signed for that subject. The signature bytes are a placeholder;
 * the signing itself is tests/oidcStatement.test.ts.
 */
const STATEMENT_SIG = '0x' + '11'.repeat(64);
function prepareOidcCircuitInputs(payload: OidcProvePayload): OidcCircuitInputs {
  const subject = oidcStatementSubject(payload, Math.floor(Date.now() / 1000));
  const modulus = '0x' + Buffer.from(subject.modulusB64url, 'base64url').toString('hex');
  return proverBuild({ ...payload, providerKeyStatement: { now: subject.now.toString(), modulus, signature: STATEMENT_SIG } });
}
const SIGNER_FIELDS = [
  'signer_kind', 'statement_sig', 'credential_tbs', 'credential_tbs_len', 'credential_sig',
  'att_auth_data', 'att_auth_data_len', 'att_client_data_hash', 'assertion_auth_data', 'assertion_auth_data_len',
] as const;
const withoutSigner = (i: OidcCircuitInputs) => Object.fromEntries(Object.entries(i).filter(([k]) => !(SIGNER_FIELDS as readonly string[]).includes(k)));

const serverBuild = (jwt: string, provider?: 'google' | 'microsoft', scope = 'myapp:membership') =>
  prepareOidcCircuitInputs({ jwt, jwks: { keys: [jwk as never] }, scope, ...(provider ? { provider } : {}) });

const keccakUtf8 = (s: string) => Array.from(ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(s))));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(CLOCK * 1000);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the client tables', () => {
  it('server and SDK name the same device clients and circuit values', () => {
    for (const p of ['google', 'microsoft'] as const) {
      expect(OIDC_DEVICE_PROVIDERS[p].deviceClientId).toBe(OIDC_PROVIDERS[p].deviceClientId);
      expect(OIDC_DEVICE_PROVIDERS[p].circuitValue).toBe(OIDC_PROVIDERS[p].circuitValue);
    }
    expect(OIDC_PROVIDERS.google.deviceClientId).toBe(GOOGLE_DEVICE);
    expect(OIDC_PROVIDERS.microsoft.deviceClientId).toBe(MICROSOFT);
    expect(SDK_MAX_PARTIAL).toBe(OIDC_MAX_PARTIAL_DATA_LENGTH);
    expect(OIDC_MAX_PARTIAL_DATA_LENGTH).toBe(2048);
  });
});

describe('server builder: what it accepts', () => {
  it('builds a Google device-flow token: aud_hash, mode 0, zero binding, now', () => {
    const out = serverBuild(signJwt(google()), 'google');
    expect(out.provider).toBe(0);
    expect(out.aud_hash).toEqual(keccakUtf8(GOOGLE_DEVICE));
    expect(out.nonce_mode).toBe(0);
    expect(out.nonce_binding).toEqual(new Array(32).fill(0));
    expect(out.now).toBe(String(CLOCK));
  });

  it('reads the provider off iss when none is named', () => {
    expect(serverBuild(signJwt(microsoft())).provider).toBe(1);
    expect(serverBuild(signJwt(google())).provider).toBe(0);
  });

  it('accepts the bare Google issuer spelling', () => {
    expect(serverBuild(signJwt(google({ iss: 'accounts.google.com' }))).provider).toBe(0);
  });

  it('builds a Microsoft device-flow token with aud first (work tenant order)', () => {
    const out = serverBuild(signJwt(microsoft()), 'microsoft');
    expect(out.aud_hash).toEqual(keccakUtf8(MICROSOFT));
    expect(out.nonce_mode).toBe(0);
  });

  it('keeps scope and nullifier as before', () => {
    const out = serverBuild(signJwt(google()), 'google', 'myapp:membership');
    const scope = keccakUtf8('myapp:membership');
    expect(out.scope).toEqual(scope);
    const pre = new Uint8Array([...keccakUtf8('alice@example.com'), ...scope]);
    expect(out.nullifier).toEqual(Array.from(ethers.getBytes(ethers.keccak256(pre))));
  });
});

describe('server builder: what it refuses before proving', () => {
  it.each([
    ['our app web client (needs a request nonce this path cannot give)', google({ aud: GOOGLE_WEB }), /is not the ZKProofport google device-flow client/],
    ['another website', google({ aud: '123-other.apps.googleusercontent.com' }), /device-flow client/],
    ['the Microsoft client id on a Google token', google({ aud: MICROSOFT }), /device-flow client/],
    ['an aud array', google({ aud: [GOOGLE_DEVICE] }), /device-flow client/],
    ['an empty aud', google({ aud: '' }), /device-flow client/],
    ['no aud', google({ aud: undefined }), /device-flow client/],
    ['a Google client id on a Microsoft token', microsoft({ aud: GOOGLE_DEVICE }), /microsoft device-flow client/],
  ])('refuses %s', (_n, payload, message) => {
    expect(() => serverBuild(signJwt(payload))).toThrow(message);
  });

  it.each([
    ['Microsoft v1.0 issuer', microsoft({ iss: 'https://sts.windows.net/72f988bf-86f1-41af-91ab-2d7cd011db47/' })],
    ['uppercase tenant', microsoft({ iss: MS_ISS.toUpperCase() })],
    ['unknown issuer', google({ iss: 'https://evil.example' })],
    ['issuer with trailing slash', google({ iss: 'https://accounts.google.com/' })],
    ['issuer as a number', google({ iss: 7 })],
    ['no issuer', google({ iss: undefined })],
  ])('refuses %s', (_n, payload) => {
    expect(() => serverBuild(signJwt(payload))).toThrow(/iss/);
  });

  it('refuses a named provider that disagrees with iss', () => {
    expect(() => serverBuild(signJwt(google()), 'microsoft')).toThrow(/was issued by google/);
  });

  it('refuses an unknown provider name', () => {
    expect(() => resolveOidcProvider('https://accounts.google.com', 'facebook')).toThrow(/Unknown OIDC provider 'facebook'/);
  });

  it.each([
    ['exp equal to the clock (expired)', google({ exp: CLOCK }), /expired/],
    ['exp in the past', google({ exp: CLOCK - 1, iat: CLOCK - 3600 }), /expired/],
    [`iat ${OIDC_IAT_CLOCK_SKEW_SECONDS + 1}s ahead of the clock`, google({ iat: CLOCK + OIDC_IAT_CLOCK_SKEW_SECONDS + 1 }), /ahead of this server's clock/],
    ['iat as a string', google({ iat: String(CLOCK) }), /iat must be a non-negative integer/],
    ['exp as a float', google({ exp: CLOCK + 0.5 }), /exp must be a non-negative integer/],
    ['negative iat', google({ iat: -1 }), /iat must be/],
  ])('refuses %s', (_n, payload, message) => {
    expect(() => serverBuild(signJwt(payload))).toThrow(message);
  });

  it('refuses email_verified given as the string "true"', () => {
    expect(() => serverBuild(signJwt(google({ email_verified: 'true' })))).toThrow(/email_verified is not true/);
  });

  it.each([['empty', ''], ['whitespace', '  '], ['not a string', 7]])('refuses a scope that is %s', (_n, scope) => {
    expect(() => prepareOidcCircuitInputs({ jwt: signJwt(google()), jwks: { keys: [jwk as never] }, scope: scope as string })).toThrow(/scope/);
  });
});

describe('now', () => {
  it('oidcNowFor refuses a clock equal to exp', () => {
    expect(() => oidcNowFor(CLOCK - 100, CLOCK, CLOCK)).toThrow(/expired/);
  });
  it('is exp - 1 at the last valid second', () => {
    expect(oidcNowFor(CLOCK - 100, CLOCK + 1, CLOCK)).toBe(BigInt(CLOCK));
  });
  it(`is raised to iat when the clock lags iat by at most ${OIDC_IAT_CLOCK_SKEW_SECONDS}s`, () => {
    expect(oidcNowFor(CLOCK + OIDC_IAT_CLOCK_SKEW_SECONDS, CLOCK + 3600, CLOCK)).toBe(BigInt(CLOCK + OIDC_IAT_CLOCK_SKEW_SECONDS));
  });
  it('a token whose iat equals the clock proves at that second', () => {
    expect(oidcNowFor(CLOCK, CLOCK + 3600, CLOCK)).toBe(BigInt(CLOCK));
  });
});

describe('SHA cut and decode offset', () => {
  // kid lengths chosen so the base64url header is 50, 63, 64, 127 and 128 characters.
  const kidFor = (headerLen: number) => {
    for (let n = 0; n < 200; n++) {
      const kid = 'k'.repeat(n);
      if (Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url').length === headerLen) return kid;
    }
    throw new Error(`no kid gives a ${headerLen}-character header`);
  };

  it.each([[50, 0], [63, 0], [64, 64], [127, 64], [128, 128]])(
    'header of %i characters: cut at %i, payload starts right after the dot',
    (headerLen, cut) => {
      const kid = kidFor(headerLen);
      const jwt = signJwt(google(), kid);
      const out = prepareOidcCircuitInputs({ jwt, jwks: { keys: [{ ...jwk, kid } as never] }, scope: 's' });
      const signed = Buffer.from(jwt.slice(0, jwt.lastIndexOf('.')));
      expect(out.base64_decode_offset).toBe(headerLen + 1 - cut);
      expect(out.base64_decode_offset).toBeGreaterThanOrEqual(1);
      expect(out.base64_decode_offset).toBeLessThanOrEqual(64);
      expect(out.partial_data.len).toBe(signed.length - cut);
      expect(Buffer.from(out.partial_data.storage.slice(0, out.partial_data.len))).toEqual(signed.subarray(cut));
      expect(out.partial_data.storage[out.base64_decode_offset - 1]).toBe('.'.charCodeAt(0));
      expect(out.full_data_length).toBe(signed.length);
      if (cut === 0) {
        // No block hashed: the midstate is SHA-256's initial value.
        expect(out.partial_hash).toEqual([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
      } else {
        expect(out.partial_hash).not.toEqual([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
      }
    },
  );

  it('the midstate is SHA-256 of the hashed blocks (checked through the final digest)', () => {
    const kid = kidFor(128);
    const jwt = signJwt(google(), kid);
    const out = prepareOidcCircuitInputs({ jwt, jwks: { keys: [{ ...jwk, kid } as never] }, scope: 's' });
    // Resume SHA-256 from the midstate over the remaining bytes with standard
    // padding, and compare with node's digest of the whole signed data.
    const signed = Buffer.from(jwt.slice(0, jwt.lastIndexOf('.')));
    const rest = Buffer.from(out.partial_data.storage.slice(0, out.partial_data.len));
    const total = signed.length;
    const padLen = ((rest.length + 9 + 63) >> 6) << 6;
    const tail = Buffer.alloc(padLen);
    rest.copy(tail);
    tail[rest.length] = 0x80;
    tail.writeBigUInt64BE(BigInt(total) * 8n, padLen - 8);
    const H = Uint32Array.from(out.partial_hash);
    const K = sha256K();
    for (let o = 0; o < tail.length; o += 64) compress(H, tail.subarray(o, o + 64), K);
    const digest = Buffer.concat(Array.from(H, h => { const b = Buffer.alloc(4); b.writeUInt32BE(h); return b; }));
    expect(digest.toString('hex')).toBe(createHash('sha256').update(signed).digest('hex'));
  });

  it('accepts the largest signed data that fits 2048 bytes and refuses the next size up', () => {
    // Header < 64 characters, so nothing is hashed ahead and partial_data is
    // the whole signed data. base64url lengths skip values, so the test takes
    // the largest reachable size <= 2048 and the smallest > 2048.
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const size = (fill: number) => header.length + 1 + Buffer.from(JSON.stringify({ ...google(), pad: 'x'.repeat(fill) })).toString('base64url').length;
    let fill = 0;
    while (size(fill + 1) <= 2048) fill++;
    const fits = signJwt({ ...google(), pad: 'x'.repeat(fill) });
    const over = signJwt({ ...google(), pad: 'x'.repeat(fill + 1) });
    expect(size(fill)).toBeGreaterThanOrEqual(2046);
    expect(serverBuild(fits).partial_data.len).toBe(size(fill));
    expect(size(fill + 1)).toBeGreaterThan(2048);
    expect(() => serverBuild(over)).toThrow(/exceeds MAX_PARTIAL_DATA_LENGTH \(2048\)/);
  });
});

describe('noir_js formatting', () => {
  it('names the four v2 public inputs as the circuit does', () => {
    const f = formatOidcInputs(serverBuild(signJwt(google())));
    expect(f.aud_hash).toEqual(keccakUtf8(GOOGLE_DEVICE).map(b => '0x' + b.toString(16).padStart(2, '0')));
    expect(f.nonce_mode).toBe('0');
    expect(f.nonce_binding).toEqual(new Array(32).fill('0x00'));
    expect(f.now).toBe(String(CLOCK));
    expect(Object.keys(f)).toEqual([
      'pubkey_modulus_limbs', 'domain', 'scope', 'nullifier', 'provider', 'aud_hash', 'nonce_mode', 'nonce_binding', 'now',
      'partial_data', 'partial_hash', 'full_data_length', 'base64_decode_offset', 'redc_params_limbs', 'signature_limbs',
      ...SIGNER_FIELDS,
    ]);
  });
});

describe('client SDK', () => {
  const serveJwks = () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [jwk] }) })) as never;
  };

  it('checkDeviceFlowToken refuses the app web client before anything is fetched', async () => {
    serveJwks();
    await expect(prepareOidcPayload({ jwt: signJwt(google({ aud: GOOGLE_WEB })), scope: 's', jwksUrl: 'https://keys' })).rejects.toThrow(/device-flow client/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('checkDeviceFlowToken refuses an expired token before anything is fetched', async () => {
    serveJwks();
    await expect(prepareOidcPayload({ jwt: signJwt(google({ exp: CLOCK })), scope: 's', jwksUrl: 'https://keys' })).rejects.toThrow(/expired/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends the provider the issuer names when none was given', async () => {
    serveJwks();
    const payload = await prepareOidcPayload({ jwt: signJwt(microsoft()), scope: 's', jwksUrl: 'https://keys' });
    expect(payload.provider).toBe('microsoft');
  });

  it.each([
    ['not a string', 7],
    ['two parts', 'a.b'],
    ['an empty part', 'a..c'],
    ['a non-JSON payload', 'eyJhIjoxfQ.bm90LWpzb24.c2ln'],
    ['a JSON array payload', `eyJhIjoxfQ.${Buffer.from('[1]').toString('base64url')}.c2ln`],
  ])('refuses a JWT that is %s', (_n, jwt) => {
    expect(() => checkDeviceFlowToken(jwt)).toThrow(/JWT/);
  });

  it('builds the same inputs as the server for the same token and clock', async () => {
    serveJwks();
    const jwt = signJwt(google());
    const sdk = await prepareOidcInputs({ jwt, scope: 'myapp:membership', jwksUrl: 'https://keys' });
    // The SDK builds no signer inputs: only this server signs, after payment-free checks.
    expect(sdk).toEqual(withoutSigner(serverBuild(jwt, undefined, 'myapp:membership')));
  });

  it('builds the same inputs as the server for a Microsoft token', async () => {
    serveJwks();
    const jwt = signJwt(microsoft());
    expect(await prepareOidcInputs({ jwt, scope: 'x', jwksUrl: 'https://keys', provider: 'microsoft' })).toEqual(withoutSigner(serverBuild(jwt, 'microsoft', 'x')));
  });
});

function sha256K(): number[] {
  const K: number[] = [];
  let n = 2;
  while (K.length < 64) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (prime) K.push(Math.floor((Math.cbrt(n) % 1) * 2 ** 32) >>> 0);
    n++;
  }
  return K;
}

function compress(H: Uint32Array, block: Buffer, K: number[]) {
  const r = (n: number, x: number) => (x >>> n) | (x << (32 - n));
  const w = new Uint32Array(64);
  for (let i = 0; i < 16; i++) w[i] = block.readUInt32BE(i * 4);
  for (let i = 16; i < 64; i++) {
    const s0 = r(7, w[i - 15]) ^ r(18, w[i - 15]) ^ (w[i - 15] >>> 3);
    const s1 = r(17, w[i - 2]) ^ r(19, w[i - 2]) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let [a, b, c, d, e, f, g, h] = H;
  for (let i = 0; i < 64; i++) {
    const t1 = (h + (r(6, e) ^ r(11, e) ^ r(25, e)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
    const t2 = ((r(2, a) ^ r(13, a) ^ r(22, a)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
}
