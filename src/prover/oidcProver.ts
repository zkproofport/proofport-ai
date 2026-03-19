/**
 * oidcProver.ts — JWT validation + circuit input preparation for OIDC proofs.
 *
 * Runs inside TEE (enclave-server) or bbProver (local mode).
 * Receives raw JWT + pre-fetched JWKS from SDK (TEE has no network access).
 *
 * Responsibilities:
 * 1. Parse and validate JWT (RS256, claims)
 * 2. Provider-specific validation (Google: email_verified + hd, Microsoft: xms_edov + tid)
 * 3. Compute RSA limbs, partial SHA-256, domain, scope, nullifier
 * 4. Return OidcCircuitInputs ready for formatOidcInputs → noir_js
 */

import { ethers } from 'ethers';
import type { OidcCircuitInputs } from './inputFormatter.js';

// ─── Circuit constants (must match main.nr) ─────────────────────────────

export const OIDC_MAX_PARTIAL_DATA_LENGTH = 768;
export const OIDC_MAX_DOMAIN_LENGTH = 64;

// ─── Types ──────────────────────────────────────────────────────────────

export interface OidcProvePayload {
  jwt: string;
  jwks: { keys: JWK[] };
  scope: string;
  provider?: 'google' | 'microsoft';
  domain?: string;
}

interface JWK {
  kid: string;
  kty: string;
  n: string;
  e: string;
  [key: string]: unknown;
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

// ─── Keccak-256 ─────────────────────────────────────────────────────────

function keccak256Bytes(data: Uint8Array): Uint8Array {
  return ethers.getBytes(ethers.keccak256(data));
}

// ─── Main: validate JWT + build circuit inputs ──────────────────────────

/**
 * Validate JWT claims and prepare circuit inputs for oidc_domain_attestation.
 *
 * Called inside TEE (enclave) or bbProver (local).
 * JWKS is pre-fetched by SDK and passed in (TEE has no network access).
 */
export function prepareOidcCircuitInputs(payload: OidcProvePayload): OidcCircuitInputs {
  const { jwt, jwks, scope } = payload;
  const providerValue = payload.provider === 'microsoft' ? 1 : 0;

  // 1. Decode JWT
  const [headerB64, payloadB64, signatureB64url] = jwt.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64url) {
    throw new Error('Invalid JWT format: expected 3 dot-separated parts');
  }

  const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(headerB64)));
  const jwtPayload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64)));

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported JWT algorithm: ${header.alg}. Only RS256 is supported.`);
  }
  if (!header.kid) {
    throw new Error('JWT header missing kid');
  }
  if (!jwtPayload.email) {
    throw new Error('JWT payload missing email claim');
  }

  // 2. Provider-specific claim validation
  if (payload.provider === 'microsoft') {
    if (!jwtPayload.xms_edov) {
      throw new Error('Microsoft JWT xms_edov is not true (email domain ownership not verified)');
    }
    if (!jwtPayload.tid) {
      throw new Error('Microsoft JWT missing tid claim (not an organizational account)');
    }
  } else if (payload.provider === 'google') {
    if (!jwtPayload.email_verified) {
      throw new Error('JWT email_verified is not true');
    }
    if (!jwtPayload.hd) {
      throw new Error('Google JWT missing hd claim (not a Google Workspace account)');
    }
  } else {
    if (!jwtPayload.email_verified) {
      throw new Error('JWT email_verified is not true');
    }
  }

  const email = jwtPayload.email as string;
  const atIndex = email.indexOf('@');
  if (atIndex === -1) {
    throw new Error(`Invalid email format: ${email}`);
  }
  const domain = payload.domain || email.substring(atIndex + 1);

  // 3. Find matching JWKS key
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) {
    throw new Error(`No JWKS key matching kid="${header.kid}". Available: ${jwks.keys.map(k => k.kid).join(', ')}`);
  }
  if (jwk.kty !== 'RSA') {
    throw new Error(`Expected RSA key, got ${jwk.kty}`);
  }

  // 4. Compute RSA limbs
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureBytes = base64urlToBytes(signatureB64url);
  const signatureBigInt = bytesToBigInt(signatureBytes);
  const modulusBytes = base64urlToBytes(jwk.n);
  const modulusBigInt = bytesToBigInt(modulusBytes);
  const redcParam = (1n << (2n * 2048n + 4n)) / modulusBigInt;

  const pubkeyLimbs = splitBigIntToChunks(modulusBigInt, 120, 18).map(v => v.toString());
  const redcLimbs = splitBigIntToChunks(redcParam, 120, 18).map(v => v.toString());
  const sigLimbs = splitBigIntToChunks(signatureBigInt, 120, 18).map(v => v.toString());

  // 5. Partial SHA-256
  const payloadJson = new TextDecoder().decode(base64urlToBytes(payloadB64));
  const emailKeyIndex = payloadJson.indexOf('"email"');
  if (emailKeyIndex === -1) {
    throw new Error('Could not find "email" key in JWT payload');
  }

  const emailKeyIndexB64 = Math.floor(emailKeyIndex / 3) * 4;
  const sliceStart = headerB64.length + 1 + emailKeyIndexB64;

  const { partialHash, remainingData } = generatePartialSHA256(signedData, sliceStart);

  if (remainingData.length > OIDC_MAX_PARTIAL_DATA_LENGTH) {
    throw new Error(
      `Remaining data after partial SHA (${remainingData.length} bytes) exceeds ` +
      `MAX_PARTIAL_DATA_LENGTH (${OIDC_MAX_PARTIAL_DATA_LENGTH}). JWT payload is too large.`,
    );
  }

  const partialDataPadded = new Uint8Array(OIDC_MAX_PARTIAL_DATA_LENGTH);
  partialDataPadded.set(remainingData);

  const shaCutoffIndex = signedData.length - remainingData.length;
  const payloadBytesInShaPrecompute = shaCutoffIndex - (headerB64.length + 1);
  const base64DecodeOffset = (4 - (payloadBytesInShaPrecompute % 4)) % 4;

  // 6. Domain BoundedVec
  const domainBytes = new TextEncoder().encode(domain);
  if (domainBytes.length > OIDC_MAX_DOMAIN_LENGTH) {
    throw new Error(`Domain "${domain}" exceeds max length ${OIDC_MAX_DOMAIN_LENGTH}`);
  }
  const domainStorage = new Uint8Array(OIDC_MAX_DOMAIN_LENGTH);
  domainStorage.set(domainBytes);

  // 7. Scope = keccak256(scope_string)
  const scopeBytes = keccak256Bytes(new TextEncoder().encode(scope));

  // 8. Nullifier = keccak256(keccak256(email) ++ scope)
  const emailBytes = new TextEncoder().encode(email);
  const emailHash = keccak256Bytes(emailBytes);
  const preimage = new Uint8Array(64);
  preimage.set(emailHash, 0);
  preimage.set(scopeBytes, 32);
  const nullifierBytes = keccak256Bytes(preimage);

  return {
    pubkey_modulus_limbs: pubkeyLimbs,
    domain: { storage: Array.from(domainStorage), len: domainBytes.length },
    scope: Array.from(scopeBytes),
    nullifier: Array.from(nullifierBytes),
    provider: providerValue,
    partial_data: { storage: Array.from(partialDataPadded), len: remainingData.length },
    partial_hash: Array.from(partialHash),
    full_data_length: signedData.length,
    base64_decode_offset: base64DecodeOffset,
    redc_params_limbs: redcLimbs,
    signature_limbs: sigLimbs,
  };
}
