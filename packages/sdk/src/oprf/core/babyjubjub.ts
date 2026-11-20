// MIRROR of proofport-app-sdk/packages/core/src/oprf/babyjubjub.ts (scripts/sync-oprf-mirror.mjs). Do not edit here.
/**
 * BabyJubJub (EIP-2494, circom's curve; the one TACEO's oprf-nr and
 * taceo-ark-babyjubjub use): a*x^2 + y^2 = 1 + d*x^2*y^2 over the BN254 scalar
 * field, a = 168700, d = 168696, cofactor 8, prime-order subgroup of order R.
 * And encode_to_curve exactly as oprf-nr v2.0.0 (hash_to_curve.nr): Poseidon2
 * hash-to-field, Elligator2 onto the Montgomery form, the rational map, then
 * the cofactor cleared.
 */
import { P, R, asciiField, invMod, legendre, mod, sqrtMod } from './field.js';
import { poseidon2T3 } from '@zkproofport-app/core/oprf';

export interface Point {
  readonly x: bigint;
  readonly y: bigint;
}

export const A = 168700n;
export const D = 168696n;

export const IDENTITY: Point = Object.freeze({ x: 0n, y: 1n });

/** The prime-order subgroup's generator (oprf-nr BABYJUBJUB_GENERATOR, arkworks' generator). */
export const GENERATOR: Point = Object.freeze({
  x: 5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  y: 16950150798460657717958625567821834550301663161624707787222815936182638968203n,
});

export function isOnCurve(p: Point): boolean {
  if (p.x < 0n || p.x >= P || p.y < 0n || p.y >= P) return false;
  const x2 = (p.x * p.x) % P;
  const y2 = (p.y * p.y) % P;
  return mod(A * x2 + y2 - 1n - ((D * x2) % P) * y2) === 0n;
}

export const isIdentity = (p: Point): boolean => p.x === 0n && p.y === 1n;

export const equals = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

export const negate = (p: Point): Point => ({ x: mod(-p.x), y: p.y });

// Projective (X : Y : Z) with x = X/Z, y = Y/Z. The twisted Edwards addition
// below (add-2008-bbjlp) is complete on BabyJubJub (a square, d not), so one
// formula serves for doubling and for the identity.
interface Projective {
  X: bigint;
  Y: bigint;
  Z: bigint;
}

function addProjective(p: Projective, q: Projective): Projective {
  const a = (p.Z * q.Z) % P;
  const b = (a * a) % P;
  const c = (p.X * q.X) % P;
  const d = (p.Y * q.Y) % P;
  const e = (((D * c) % P) * d) % P;
  const f = mod(b - e);
  const g = (b + e) % P;
  const h = mod((((p.X + p.Y) % P) * ((q.X + q.Y) % P)) % P - c - d);
  return {
    X: (((a * f) % P) * h) % P,
    Y: (((a * g) % P) * mod(d - A * c)) % P,
    Z: (f * g) % P,
  };
}

const toProjective = (p: Point): Projective => ({ X: p.x, Y: p.y, Z: 1n });

function toAffine(p: Projective): Point {
  const zInv = invMod(p.Z);
  return { x: (p.X * zInv) % P, y: (p.Y * zInv) % P };
}

export const add = (p: Point, q: Point): Point => toAffine(addProjective(toProjective(p), toProjective(q)));

/** k * p for any non-negative integer k (not reduced: callers decide the modulus). */
export function scalarMul(p: Point, k: bigint): Point {
  if (k < 0n) throw new Error('negative scalar');
  let acc: Projective = { X: 0n, Y: 1n, Z: 1n };
  let base = toProjective(p);
  let e = k;
  while (e > 0n) {
    if (e & 1n) acc = addProjective(acc, base);
    base = addProjective(base, base);
    e >>= 1n;
  }
  return toAffine(acc);
}

/** On the curve and in the prime-order subgroup (r * p is the identity). */
export function isInSubgroup(p: Point): boolean {
  return isOnCurve(p) && isIdentity(scalarMul(p, R));
}

// ---- encode_to_curve (oprf-nr v2.0.0, hash_to_curve.nr) ----------------------

/** b"OPRF_HashToField_BabyJubJub" */
export const DS_HASH_TO_FIELD = asciiField('OPRF_HashToField_BabyJubJub');

const MONT_A = 168698n;
const Z = 5n;

const inverseOrZero = (x: bigint): bigint => (mod(x) === 0n ? 0n : invMod(x));
const sgn0 = (x: bigint): boolean => (mod(x) & 1n) === 1n;

/** RFC 9380 Elligator2 onto t^2 = s^3 + 168698 s^2 + s, with oprf-nr's sign rule. */
export function mapToCurveElligator2(u: bigint): { s: bigint; t: bigint } {
  const tv10 = (((Z * u) % P) * u) % P;
  const tv1 = mod(tv10 + 1n) === 0n ? 0n : tv10;
  const x1 = mod(-MONT_A * inverseOrZero(tv1 + 1n));
  const gx1 = mod((((x1 + MONT_A) * x1 + 1n) % P) * x1);
  const x2 = mod(-x1 - MONT_A);
  const gx2 = (tv1 * gx1) % P;
  const gx1IsSquare = legendre(gx1) !== -1;
  const x = gx1IsSquare ? x1 : x2;
  const gx = gx1IsSquare ? gx1 : gx2;
  let y = sqrtMod(gx);
  // gx1 square: sgn0(y) must be 1; otherwise 0.
  if (gx1IsSquare !== sgn0(y)) y = mod(-y);
  return { s: x, t: y };
}

function rationalMapMontToEdwards(s: bigint, t: bigint): Point {
  const tv1 = mod(s + 1n);
  const tv2 = inverseOrZero((tv1 * t) % P);
  const v = (tv1 * tv2) % P;
  const w = (tv2 * t) % P;
  return {
    x: (s * v) % P,
    y: tv2 === 0n ? 1n : (w * mod(s - 1n)) % P,
  };
}

/** encode_to_curve(input): a point in the prime-order subgroup. */
export function encodeToCurve(input: bigint): Point {
  const u = poseidon2T3([DS_HASH_TO_FIELD, input, 0n])[1];
  const { s, t } = mapToCurveElligator2(u);
  const q = rationalMapMontToEdwards(s, t);
  let pp = toProjective(q);
  for (let i = 0; i < 3; i++) pp = addProjective(pp, pp);
  return toAffine(pp);
}
