/**
 * The client's half of the nodes' threshold (Shamir) Chaum-Pedersen proof,
 * ported from taceo-oprf-core 0.6.3 (`ddlog_equality.rs`,
 * `ddlog_equality/shamir.rs`, `shamir.rs`) and taceo-oprf-client 0.10.8
 * (`generate_challenge_request`, `verify_dlog_equality`):
 *
 *   round 1   node i answers c_i = x_i*A and nonce commitments d1_i, d2_i, e1_i, e2_i
 *   combine   C = sum(lambda_i * c_i) (Lagrange at 0 over party ids + 1), D1.. = plain sums
 *   round 2   node i answers its share s_i of the response
 *   finish    s = sum(s_i);  b = BLAKE3-XOF(label, request id, parties, D, C, D1, D2, E1, E2) mod r
 *             R1 = D1 + b*E1,  R2 = D2 + b*E2
 *             e = Poseidon2_t16(DS_dlog, D, A, C, G, R1, R2, 0, 0, 0)[1]
 *
 * (e, s) is then checked by the mirrored core client (verifyOprfDlogEquality),
 * exactly as the circuit checks it. Points travel in arkworks' compressed form
 * (y little-endian, x's sign in the top bit), scalars as 32 bytes
 * little-endian.
 */
import { GENERATOR, add, isIdentity, isInSubgroup, isOnCurve, scalarMul, A as CURVE_A, D as CURVE_D, type Point } from './core/babyjubjub.js';
import { P, R, invMod, mod, sqrtMod, legendre } from './core/field.js';
import { OPRF_DS_DLOG, poseidon2T16 } from '@zkproofport-app/core/oprf';
import { blake3 } from './blake3.js';

const HALF_P = (P - 1n) / 2n;

function leBytes(v: bigint, len = 32): Uint8Array {
  const out = new Uint8Array(len);
  let x = v;
  for (let i = 0; i < len; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error(`${v} does not fit ${len} bytes`);
  return out;
}

function fromLe(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/** arkworks `serialize_compressed` of a twisted Edwards affine point. */
export function compressPoint(p: Point): Uint8Array {
  if (!isOnCurve(p)) throw new Error('compressPoint: not on BabyJubJub');
  const out = leBytes(p.y);
  if (p.x > HALF_P) out[31] |= 0x80;
  return out;
}

/**
 * arkworks `deserialize_compressed` with validation: y below p, the x the
 * curve gives with the flagged sign, on the curve, in the prime-order
 * subgroup. Throws naming `what` for anything else.
 */
export function decompressPoint(bytes: unknown, what: string): Point {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new Error(`${what} must be a 32-byte compressed point.`);
  }
  const negative = (bytes[31] & 0x80) !== 0;
  const yBytes = bytes.slice();
  yBytes[31] &= 0x7f;
  const y = fromLe(yBytes);
  if (y >= P) throw new Error(`${what}: y is not below the field modulus.`);
  const y2 = (y * y) % P;
  const den = mod(CURVE_A - CURVE_D * y2);
  if (den === 0n) throw new Error(`${what} is not a point of BabyJubJub.`);
  const x2 = mod((1n - y2) * invMod(den));
  if (legendre(x2) === -1) throw new Error(`${what} is not a point of BabyJubJub.`);
  let x = sqrtMod(x2);
  if ((x > HALF_P) !== negative) x = mod(-x);
  if (x === 0n && negative) throw new Error(`${what}: x is zero but flagged negative.`);
  const p = { x, y };
  if (!isInSubgroup(p)) throw new Error(`${what} is not in BabyJubJub's prime-order subgroup.`);
  return p;
}

/** A 32-byte little-endian scalar below r (`ark_serde_compat::field` for Fr). */
export function decodeScalar(bytes: unknown, what: string): bigint {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error(`${what} must be a 32-byte scalar.`);
  const v = fromLe(bytes);
  if (v >= R) throw new Error(`${what} is not below the subgroup order.`);
  return v;
}

/** Lagrange coefficient at 0 for `id` over `ids`, mod r (taceo shamir::single_lagrange_from_coeff). */
export function lagrangeAtZero(id: number, ids: readonly number[]): bigint {
  let num = 1n;
  let den = 1n;
  for (const j of ids) {
    if (j === id) continue;
    num = (num * BigInt(j)) % R;
    den = mod(den * (BigInt(j) - BigInt(id)), R);
  }
  return mod(num * invMod(den, R), R);
}

export interface PartialCommitments {
  c: Point;
  d1: Point;
  d2: Point;
  e1: Point;
  e2: Point;
}

export interface CombinedCommitments extends PartialCommitments {
  /** Party ids + 1, ascending (what the nodes call contributing parties). */
  contributingParties: number[];
}

/**
 * DLogCommitmentsShamir::combine_commitments. `partials` and `partyIds` in the
 * same order; party ids are the nodes' 0-based ids, unique.
 */
export function combineCommitments(partials: readonly PartialCommitments[], partyIds: readonly number[]): CombinedCommitments {
  if (partials.length !== partyIds.length || partials.length === 0) {
    throw new Error('combineCommitments: one commitment per party, at least one.');
  }
  const parties = partyIds.map(id => {
    if (!Number.isInteger(id) || id < 0 || id >= 0xffff) throw new Error(`party id ${id} is not a u16 below 65535.`);
    return id + 1;
  });
  if (new Set(parties).size !== parties.length) throw new Error('Two answers carry the same party id.');
  const sum = (pick: (c: PartialCommitments) => Point) =>
    partials.reduce<Point>((acc, c) => add(acc, pick(c)), { x: 0n, y: 1n });
  const c = partials.reduce<Point>(
    (acc, comm, i) => add(acc, scalarMul(comm.c, lagrangeAtZero(parties[i], parties))),
    { x: 0n, y: 1n },
  );
  return { c, d1: sum(x => x.d1), d2: sum(x => x.d2), e1: sum(x => x.e1), e2: sum(x => x.e2), contributingParties: parties };
}

const NONCE_COMBINER_LABEL = new TextEncoder().encode('FROST_2_NONCE_COMBINER');

/** combine_two_nonce_randomness: (R1, R2, b). */
export function combineNonces(requestId: Uint8Array, publicKey: Point, combined: CombinedCommitments): { r1: Point; r2: Point; b: bigint } {
  if (requestId.length !== 16) throw new Error('request id must be 16 bytes.');
  const parts: Uint8Array[] = [NONCE_COMBINER_LABEL, requestId];
  for (const party of combined.contributingParties) parts.push(Uint8Array.of(party & 0xff, party >> 8));
  for (const p of [publicKey, combined.c, combined.d1, combined.d2, combined.e1, combined.e2]) parts.push(compressPoint(p));
  const input = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    input.set(p, off);
    off += p.length;
  }
  const b = mod(fromLe(blake3(input, 64)), R);
  return { r1: add(combined.d1, scalarMul(combined.e1, b)), r2: add(combined.d2, scalarMul(combined.e2, b)), b };
}

/** dlog_equality::challenge_hash(a = public key, b = blinded query, c = blinded response, d = G, r1, r2). */
export function challengeHash(publicKey: Point, blindedQuery: Point, blindedResponse: Point, r1: Point, r2: Point): bigint {
  return poseidon2T16([
    OPRF_DS_DLOG,
    publicKey.x, publicKey.y,
    blindedQuery.x, blindedQuery.y,
    blindedResponse.x, blindedResponse.y,
    GENERATOR.x, GENERATOR.y,
    r1.x, r1.y,
    r2.x, r2.y,
    0n, 0n, 0n,
  ])[1];
}

/**
 * DLogCommitmentsShamir::combine_proofs: the combined proof (e, s) for the
 * blinded response C = combined.c. Not checked here; the caller verifies it.
 */
export function combineProofs(args: {
  requestId: Uint8Array;
  shares: readonly bigint[];
  combined: CombinedCommitments;
  publicKey: Point;
  blindedQuery: Point;
}): { e: bigint; s: bigint } {
  if (args.shares.length !== args.combined.contributingParties.length) {
    throw new Error(`Expected ${args.combined.contributingParties.length} proof shares, got ${args.shares.length}.`);
  }
  const s = args.shares.reduce((acc, v) => mod(acc + v, R), 0n);
  const { r1, r2 } = combineNonces(args.requestId, args.publicKey, args.combined);
  if (isIdentity(args.combined.c)) throw new Error('The nodes\' combined answer is the identity.');
  return { e: challengeHash(args.publicKey, args.blindedQuery, args.combined.c, r1, r2), s };
}

export const toLeScalarBytes = (v: bigint): Uint8Array => leBytes(v);
