// MIRROR of proofport-app-sdk/packages/core/src/oprf/field.ts (scripts/sync-oprf-mirror.mjs). Do not edit here.
/**
 * BN254 scalar field (what a Noir `Field` holds, and BabyJubJub's base field)
 * and BabyJubJub's prime-order subgroup order, with the strict parsing the
 * OPRF values need. Plain bigint, no dependencies.
 */

/** BN254 scalar field modulus p. */
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Order r of BabyJubJub's prime-order subgroup: an OPRF key, a blinding factor and `s` are below it. */
export const R = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

export function mod(a: bigint, m: bigint = P): bigint {
  const x = a % m;
  return x < 0n ? x + m : x;
}

export function powMod(base: bigint, exp: bigint, m: bigint = P): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/** a^-1 mod m; 0 has none and throws. */
export function invMod(a: bigint, m: bigint = P): bigint {
  const x = mod(a, m);
  if (x === 0n) throw new Error('0 has no inverse');
  // Extended Euclid; m is prime in every use here.
  let [oldR, r] = [x, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return mod(oldS, m);
}

/** 1 for a non-zero square, -1 for a non-square, 0 for 0 (mod p). */
export function legendre(a: bigint): -1 | 0 | 1 {
  const x = mod(a);
  if (x === 0n) return 0;
  return powMod(x, (P - 1n) / 2n) === 1n ? 1 : -1;
}

// Tonelli-Shanks for p - 1 = 2^28 * Q.
const S = 28n;
const Q = (P - 1n) >> S;
const NON_RESIDUE = 5n;

/** A square root of a square mod p; throws for a non-square. Which root is not specified. */
export function sqrtMod(a: bigint): bigint {
  const n = mod(a);
  if (n === 0n) return 0n;
  if (legendre(n) !== 1) throw new Error('not a square');
  let m = S;
  let c = powMod(NON_RESIDUE, Q);
  let t = powMod(n, Q);
  let r = powMod(n, (Q + 1n) / 2n);
  while (t !== 1n) {
    let i = 0n;
    let t2 = t;
    while (t2 !== 1n) {
      t2 = (t2 * t2) % P;
      i++;
    }
    const b = powMod(c, 1n << (m - i - 1n));
    m = i;
    c = (b * b) % P;
    t = (t * c) % P;
    r = (r * b) % P;
  }
  return r;
}

export function toHex32(v: bigint): string {
  if (v < 0n || v >= 1n << 256n) throw new Error(`${v} does not fit 32 bytes`);
  return '0x' + v.toString(16).padStart(64, '0');
}

/**
 * A value below `modulus`, from a bigint, a safe integer, a 0x hex string or a
 * decimal string. Never reduced: a value at or above the modulus is refused,
 * because two encodings of one value would be two inputs that mean the same.
 */
export function parseBelow(value: unknown, modulus: bigint, what: string): bigint {
  let v: bigint;
  if (typeof value === 'bigint') {
    v = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${what} must be an integer, got ${value}.`);
    v = BigInt(value);
  } else if (typeof value === 'string') {
    if (!/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(value)) {
      throw new Error(`${what} must be 0x-prefixed hex (at most 32 bytes) or a decimal string, got ${JSON.stringify(value)}.`);
    }
    v = BigInt(value);
  } else {
    throw new Error(`${what} must be a bigint, number or string, got ${value === null ? 'null' : typeof value}.`);
  }
  if (v < 0n) throw new Error(`${what} is negative.`);
  if (v >= modulus) throw new Error(`${what} (${toHex32(v)}) is not below the modulus ${toHex32(modulus)}.`);
  return v;
}

/** A BN254 field element (below p). */
export const parseField = (value: unknown, what: string): bigint => parseBelow(value, P, what);

/** A BabyJubJub scalar (below r). */
export const parseScalar = (value: unknown, what: string): bigint => parseBelow(value, R, what);

/** An ASCII string read as a big-endian integer: how every OPRF domain separator is written. */
export function asciiField(s: string): bigint {
  let v = 0n;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) throw new Error(`domain separator ${JSON.stringify(s)} is not ASCII`);
    v = (v << 8n) | BigInt(c);
  }
  if (v >= P) throw new Error(`domain separator ${JSON.stringify(s)} does not fit the field`);
  return v;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export function bigIntToBytes32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error(`${v} does not fit 32 bytes`);
  return out;
}
