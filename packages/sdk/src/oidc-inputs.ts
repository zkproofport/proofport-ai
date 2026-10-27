/**
 * OIDC Domain Attestation — Input builder.
 *
 * Takes a raw JWT token + scope string, and produces all circuit inputs
 * needed for the oidc_domain_attestation circuit.
 *
 * Steps:
 * 1. Decode JWT header → kid, iss; refuse a token the prover would refuse
 *    (issuer, audience, expiry -- see checkDeviceFlowToken)
 * 2. Fetch JWKS via OIDC Discovery → find matching RSA public key
 * 3. Compute RSA limbs (modulus, redc_params, signature) — 18 × 120-bit
 * 4. Compute partial SHA-256 (precompute up to the block holding the `.`)
 * 5. Extract email → derive domain
 * 6. Compute scope = keccak256(scope_string)
 * 7. Compute nullifier = keccak256(keccak256(email) ++ scope)
 * 8. aud_hash = keccak256(aud), nonce_mode 0, zero nonce_binding, now
 *
 * Circuit v2 (circuits oidc-domain-attestation, 214 public inputs): offsets
 * 0-147 as before, then aud_hash 148-179, nonce_mode 180, nonce_binding
 * 181-212, now 213. This SDK signs in with the device flow, which cannot carry
 * a nonce, so it always proves in nonce_mode 0 with an all-zero binding, and
 * only the device-flow clients' tokens are accepted (ZKProofport verifiers
 * refuse the Google device client in any other mode).
 */

import { ethers } from 'ethers';

// ─── Circuit constants (must match main.nr) ─────────────────────────────

export const OIDC_MAX_PARTIAL_DATA_LENGTH = 2048;
export const OIDC_MAX_DOMAIN_LENGTH = 64;
export const OIDC_MAX_EMAIL_LENGTH = 128;
/** Public inputs of the v2 circuit. */
export const OIDC_PUBLIC_INPUT_COUNT = 214;

export type OidcProviderName = 'google' | 'microsoft';

/**
 * Per provider: the circuit's `provider` value, the issuers it accepts, and the
 * device-flow client whose tokens are proved (packages/mcp/src/prove.ts).
 * Kept equal to the server's src/prover/oidcProver.ts by a test.
 */
export const OIDC_DEVICE_PROVIDERS: Readonly<Record<OidcProviderName, {
  circuitValue: number;
  isIssuer: (iss: string) => boolean;
  deviceClientId: string;
}>> = Object.freeze({
  google: {
    circuitValue: 0,
    isIssuer: (iss: string) => iss === 'https://accounts.google.com' || iss === 'accounts.google.com',
    deviceClientId: '491923400813-pr17m6kpin2rsbbes18jpb60j1s3qmv4.apps.googleusercontent.com',
  },
  microsoft: {
    circuitValue: 1,
    isIssuer: (iss: string) =>
      /^https:\/\/login\.microsoftonline\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/v2\.0$/.test(iss),
    deviceClientId: '8b09c842-d7a8-4d9c-a6ea-46c797412bac',
  },
});

/** How far the local clock may lag a token's iat before `now` is moved up to iat. */
export const OIDC_IAT_CLOCK_SKEW_SECONDS = 60;

// ─── Types ──────────────────────────────────────────────────────────────

export interface OidcCircuitInputs {
  // Public inputs
  pubkey_modulus_limbs: string[];   // 18 × u128 decimal strings
  domain: { storage: number[]; len: number };
  scope: number[];                  // 32 bytes
  nullifier: number[];              // 32 bytes
  provider: number;              // 0=Google, 1=Microsoft
  aud_hash: number[];               // 32 bytes, keccak256(aud)
  nonce_mode: number;               // always 0 here: the device flow carries no nonce
  nonce_binding: number[];          // 32 zero bytes in nonce_mode 0
  now: string;                      // u64 unix seconds, decimal; iat <= now < exp

  // Private inputs
  partial_data: { storage: number[]; len: number };
  partial_hash: number[];           // 8 × u32
  full_data_length: number;
  base64_decode_offset: number;
  redc_params_limbs: string[];      // 18 × u128 decimal strings
  signature_limbs: string[];        // 18 × u128 decimal strings
}

export interface PrepareOidcParams {
  /** Raw JWT string (header.payload.signature) */
  jwt: string;
  /** Scope string for nullifier (e.g. "openstoa:topic:test") */
  scope: string;
  /** Domain to prove. If omitted, auto-extracted from email claim. */
  domain?: string;
  /** Override JWKS URL instead of using OIDC Discovery */
  jwksUrl?: string;
  /** OIDC provider. Optional: read off the token's `iss`; when given it must agree. */
  provider?: OidcProviderName;
}

/** What {@link checkDeviceFlowToken} established about a token. */
export interface DeviceFlowToken {
  provider: OidcProviderName;
  aud: string;
  /** The `now` public input, unix seconds. */
  now: bigint;
}

function decodeJsonPart(part: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(base64urlToBytes(part)));
  } catch {
    throw new Error(`JWT ${what} is not base64url-encoded JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`JWT ${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Refuse, before anything is fetched or paid for, a token the OIDC circuit or
 * a ZKProofport verifier would refuse: an issuer that is not Google or a
 * Microsoft v2.0 tenant, a `provider` that disagrees with the issuer, an
 * audience other than our device-flow client, and a token expired (or issued
 * more than {@link OIDC_IAT_CLOCK_SKEW_SECONDS}s ahead of this clock).
 */
export function checkDeviceFlowToken(
  jwt: unknown,
  named?: unknown,
  clockSeconds: number = Math.floor(Date.now() / 1000),
): DeviceFlowToken {
  if (typeof jwt !== 'string') throw new Error('Invalid JWT format: expected a string');
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some(p => p.length === 0)) {
    throw new Error('Invalid JWT format: expected 3 dot-separated parts');
  }
  const payload = decodeJsonPart(parts[1], 'payload');

  if (named !== undefined && !Object.prototype.hasOwnProperty.call(OIDC_DEVICE_PROVIDERS, named as string)) {
    throw new Error(`Unknown OIDC provider '${String(named)}'. Known: ${Object.keys(OIDC_DEVICE_PROVIDERS).join(', ')}.`);
  }
  const iss = payload.iss;
  if (typeof iss !== 'string') {
    throw new Error(`JWT iss claim must be a string, got ${iss === null ? 'null' : typeof iss}.`);
  }
  const matches = (Object.keys(OIDC_DEVICE_PROVIDERS) as OidcProviderName[]).filter(p => OIDC_DEVICE_PROVIDERS[p].isIssuer(iss));
  if (matches.length !== 1) {
    throw new Error(
      `JWT iss '${iss}' is not a Google issuer (https://accounts.google.com) or a Microsoft v2.0 tenant issuer ` +
      '(https://login.microsoftonline.com/<tenant-guid>/v2.0).',
    );
  }
  const provider = matches[0];
  if (named !== undefined && named !== provider) {
    throw new Error(`provider '${String(named)}' was given, but the JWT was issued by ${provider} (iss '${iss}').`);
  }

  const deviceClientId = OIDC_DEVICE_PROVIDERS[provider].deviceClientId;
  if (payload.aud !== deviceClientId) {
    throw new Error(
      `JWT aud ${JSON.stringify(payload.aud)} is not the ZKProofport ${provider} device-flow client ` +
      `(${deviceClientId}). Sign in with the @zkproofport-ai/mcp device login (zkproofport-prove ` +
      '--login-google-workspace or --login-microsoft-365); id_tokens issued to other clients cannot be proved here.',
    );
  }

  const { iat, exp } = payload;
  if (!Number.isSafeInteger(iat) || (iat as number) < 0) {
    throw new Error(`JWT iat must be a non-negative integer, got ${JSON.stringify(iat)}.`);
  }
  if (!Number.isSafeInteger(exp) || (exp as number) < 0) {
    throw new Error(`JWT exp must be a non-negative integer, got ${JSON.stringify(exp)}.`);
  }
  let now = clockSeconds;
  if (now < (iat as number)) {
    if ((iat as number) - now > OIDC_IAT_CLOCK_SKEW_SECONDS) {
      throw new Error(
        `JWT iat ${iat} is ${(iat as number) - now}s ahead of this clock ${now}; at most ${OIDC_IAT_CLOCK_SKEW_SECONDS}s is tolerated.`,
      );
    }
    now = iat as number;
  }
  if (now >= (exp as number)) {
    throw new Error(`JWT expired at ${exp} (now ${now}). Sign in again for a fresh id_token.`);
  }
  return { provider, aud: deviceClientId, now: BigInt(now) };
}

// ─── BigInt helpers ─────────────────────────────────────────────────────

function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  const padded = b64 + '='.repeat(pad);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = '0x';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return BigInt(hex);
}

function splitBigIntToChunks(value: bigint, chunkSize: number, numChunks: number): bigint[] {
  const mask = (1n << BigInt(chunkSize)) - 1n;
  const chunks: bigint[] = [];
  for (let i = 0; i < numChunks; i++) {
    chunks.push((value >> (BigInt(i) * BigInt(chunkSize))) & mask);
  }
  return chunks;
}

// ─── Partial SHA-256 ────────────────────────────────────────────────────

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Block(H: Uint32Array, block: Uint8Array): void {
  const w = new Uint32Array(64);
  let a = H[0], b = H[1], c = H[2], d = H[3];
  let e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 16; i++) {
    w[i] = (block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3];
  }
  for (let i = 16; i < 64; i++) {
    const s0 = rotr(7, w[i - 15]) ^ rotr(18, w[i - 15]) ^ (w[i - 15] >>> 3);
    const s1 = rotr(17, w[i - 2]) ^ rotr(19, w[i - 2]) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  for (let i = 0; i < 64; i++) {
    const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
    const ch = (e & f) ^ (~e & g);
    const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
    const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (S0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + temp1) >>> 0;
    d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
  }
  H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
  H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
  H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
  H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
}

function generatePartialSHA256(
  data: Uint8Array,
  hashUntilIndex: number,
): { partialHash: Uint32Array; remainingData: Uint8Array } {
  const blockSize = 64;
  const blockIndex = Math.floor(hashUntilIndex / blockSize);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  for (let i = 0; i < blockIndex; i++) {
    const block = new Uint8Array(blockSize);
    block.set(data.slice(i * blockSize, (i + 1) * blockSize));
    sha256Block(H, block);
  }
  return { partialHash: H, remainingData: data.slice(blockIndex * blockSize) };
}

// ─── JWKS fetching ──────────────────────────────────────────────────────

interface JWK {
  kid: string;
  kty: string;
  n: string;
  e: string;
  [key: string]: unknown;
}

async function fetchJwksUrl(issuer: string): Promise<string> {
  const discoveryUrl = issuer.endsWith('/')
    ? `${issuer}.well-known/openid-configuration`
    : `${issuer}/.well-known/openid-configuration`;
  const resp = await fetch(discoveryUrl);
  if (!resp.ok) {
    throw new Error(`OIDC Discovery failed for ${discoveryUrl}: ${resp.status}`);
  }
  const config = await resp.json() as { jwks_uri: string };
  if (!config.jwks_uri) {
    throw new Error(`No jwks_uri in OIDC Discovery response from ${discoveryUrl}`);
  }
  return config.jwks_uri;
}

async function fetchMatchingKey(jwksUrl: string, kid: string): Promise<JWK> {
  const resp = await fetch(jwksUrl);
  if (!resp.ok) {
    throw new Error(`JWKS fetch failed: ${resp.status}`);
  }
  const jwks = await resp.json() as { keys: JWK[] };
  const key = jwks.keys.find(k => k.kid === kid);
  if (!key) {
    throw new Error(`No JWKS key matching kid="${kid}". Available: ${jwks.keys.map(k => k.kid).join(', ')}`);
  }
  if (key.kty !== 'RSA') {
    throw new Error(`Expected RSA key, got ${key.kty}`);
  }
  return key;
}

/**
 * Fetch full JWKS keyset from OIDC Discovery for a given JWT.
 * SDK fetches this because TEE has no network access.
 */
async function fetchJwksForJwt(jwt: string, jwksUrlOverride?: string): Promise<{ keys: JWK[] }> {
  const [headerB64] = jwt.split('.');
  if (!headerB64) throw new Error('Invalid JWT format');
  const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(headerB64)));
  if (!header.kid) throw new Error('JWT header missing kid');

  // Decode payload to get issuer
  const payloadB64 = jwt.split('.')[1];
  if (!payloadB64) throw new Error('Invalid JWT format');
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64)));

  const jwksUrl = jwksUrlOverride || await fetchJwksUrl(payload.iss);
  const resp = await fetch(jwksUrl);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  return resp.json() as Promise<{ keys: JWK[] }>;
}

// ─── Keccak-256 helpers ─────────────────────────────────────────────────

function keccak256Bytes(data: Uint8Array): Uint8Array {
  return ethers.getBytes(ethers.keccak256(data));
}

// ─── Main export ────────────────────────────────────────────────────────

/**
 * Prepare all circuit inputs for oidc_domain_attestation from a raw JWT.
 *
 * @param params.jwt - Raw JWT string from OIDC provider (e.g. Google id_token)
 * @param params.scope - Scope string for nullifier derivation
 * @param params.domain - Domain to prove (auto-extracted from email if omitted)
 * @param params.jwksUrl - Override JWKS URL (skips OIDC Discovery)
 */
export async function prepareOidcInputs(params: PrepareOidcParams): Promise<OidcCircuitInputs> {
  const { jwt, scope } = params;
  const token = checkDeviceFlowToken(jwt, params.provider);
  const providerValue = OIDC_DEVICE_PROVIDERS[token.provider].circuitValue;

  // 1. Decode JWT
  const [headerB64, payloadB64, signatureB64url] = jwt.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64url) {
    throw new Error('Invalid JWT format: expected 3 dot-separated parts');
  }

  const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64)));

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported JWT algorithm: ${header.alg}. Only RS256 is supported.`);
  }
  if (!header.kid) {
    throw new Error('JWT header missing kid');
  }
  if (!payload.email) {
    throw new Error('JWT payload missing email claim');
  }
  if (token.provider === 'microsoft') {
    if (!payload.xms_edov) {
      throw new Error('Microsoft JWT xms_edov is not true (email domain ownership not verified)');
    }
    if (!payload.tid) {
      throw new Error('Microsoft JWT missing tid claim (not an organizational account)');
    }
  } else {
    if (payload.email_verified !== true) {
      throw new Error('JWT email_verified is not true');
    }
    if (!payload.hd) {
      throw new Error('Google JWT missing hd claim (not a Google Workspace account)');
    }
  }

  const email = payload.email as string;
  const atIndex = email.indexOf('@');
  if (atIndex === -1) {
    throw new Error(`Invalid email format: ${email}`);
  }
  const domain = params.domain || email.substring(atIndex + 1);

  // 2. Fetch JWKS and find matching key
  const jwksUrl = params.jwksUrl || await fetchJwksUrl(payload.iss);
  const jwk = await fetchMatchingKey(jwksUrl, header.kid);

  // 3. Compute RSA limbs
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureBytes = base64urlToBytes(signatureB64url);
  const signatureBigInt = bytesToBigInt(signatureBytes);
  const modulusBytes = base64urlToBytes(jwk.n);
  const modulusBigInt = bytesToBigInt(modulusBytes);
  const redcParam = (1n << (2n * 2048n + 4n)) / modulusBigInt;

  const pubkeyLimbs = splitBigIntToChunks(modulusBigInt, 120, 18).map(v => v.toString());
  const redcLimbs = splitBigIntToChunks(redcParam, 120, 18).map(v => v.toString());
  const sigLimbs = splitBigIntToChunks(signatureBigInt, 120, 18).map(v => v.toString());

  // 4. Partial SHA-256: cut at the 64-byte block holding the header/payload
  // `.`, so partial_data carries the whole payload (the circuit reads iss, aud,
  // iat and exp, which precede email); the payload starts 1..64 bytes in.
  const dot = headerB64.length;
  const cut = Math.floor(dot / 64) * 64;
  const { partialHash, remainingData } = generatePartialSHA256(signedData, cut);

  if (remainingData.length > OIDC_MAX_PARTIAL_DATA_LENGTH) {
    throw new Error(
      `Remaining data after partial SHA (${remainingData.length} bytes) exceeds ` +
      `MAX_PARTIAL_DATA_LENGTH (${OIDC_MAX_PARTIAL_DATA_LENGTH}). JWT payload is too large.`,
    );
  }

  const partialDataPadded = new Uint8Array(OIDC_MAX_PARTIAL_DATA_LENGTH);
  partialDataPadded.set(remainingData);

  const base64DecodeOffset = dot + 1 - cut;

  // 5. Domain BoundedVec
  const domainBytes = new TextEncoder().encode(domain);
  if (domainBytes.length > OIDC_MAX_DOMAIN_LENGTH) {
    throw new Error(`Domain "${domain}" exceeds max length ${OIDC_MAX_DOMAIN_LENGTH}`);
  }
  const domainStorage = new Uint8Array(OIDC_MAX_DOMAIN_LENGTH);
  domainStorage.set(domainBytes);

  // 6. Scope = keccak256(scope_string)
  const scopeBytes = keccak256Bytes(new TextEncoder().encode(scope));

  // 7. Nullifier = keccak256(keccak256(email) ++ scope)
  const emailBytes = new TextEncoder().encode(email);
  const emailHash = keccak256Bytes(emailBytes);
  const preimage = new Uint8Array(64);
  preimage.set(emailHash, 0);
  preimage.set(scopeBytes, 32);
  const nullifierBytes = keccak256Bytes(preimage);

  // 8. aud_hash = keccak256(aud); device flow: nonce_mode 0, zero binding.
  const audHash = keccak256Bytes(new TextEncoder().encode(token.aud));

  return {
    pubkey_modulus_limbs: pubkeyLimbs,
    domain: { storage: Array.from(domainStorage), len: domainBytes.length },
    scope: Array.from(scopeBytes),
    nullifier: Array.from(nullifierBytes),
    provider: providerValue,
    aud_hash: Array.from(audHash),
    nonce_mode: 0,
    nonce_binding: new Array(32).fill(0),
    now: token.now.toString(),
    partial_data: { storage: Array.from(partialDataPadded), len: remainingData.length },
    partial_hash: Array.from(partialHash),
    full_data_length: signedData.length,
    base64_decode_offset: base64DecodeOffset,
    redc_params_limbs: redcLimbs,
    signature_limbs: sigLimbs,
  };
}

// ─── OIDC Payload (SDK → Server → TEE) ──────────────────────────────────

export interface OidcProvePayload {
  jwt: string;
  jwks: { keys: { kid: string; kty: string; n: string; e: string; [key: string]: unknown }[] };
  scope: string;
  provider: OidcProviderName;
}

/**
 * Prepare OIDC payload for server submission.
 * SDK fetches JWKS (TEE has no network access) and sends raw JWT + JWKS to server.
 * TEE performs JWT validation, claim checks, and circuit input preparation.
 *
 * Refuses up front (before JWKS is fetched or a payment is made) a token the
 * prover would refuse: see {@link checkDeviceFlowToken}. The provider sent is
 * the one the token's issuer names.
 */
export async function prepareOidcPayload(params: PrepareOidcParams): Promise<OidcProvePayload> {
  const token = checkDeviceFlowToken(params.jwt, params.provider);
  const jwks = await fetchJwksForJwt(params.jwt, params.jwksUrl);
  return {
    jwt: params.jwt,
    jwks,
    scope: params.scope,
    provider: token.provider,
  };
}

