// MIRROR of proofport-app-sdk/packages/core/src/oprf/poseidon2.ts (scripts/sync-oprf-mirror.mjs). Do not edit here.
/**
 * BN254 Poseidon2 permutations of width 3, 4 and 16, exactly as the Noir
 * library the circuits use (circuits/deps/noir-poseidon/poseidon2,
 * `permute_bn254`): external matrix, 4 full rounds, the partial rounds, 4 full
 * rounds, x^5 S-box. The OPRF construction reads output `state[1]`.
 */
import { P } from './field.js';
import { POSEIDON2_T3, POSEIDON2_T4, POSEIDON2_T16, type Poseidon2Params } from './poseidon2Constants.generated.js';

interface Params {
  firstFull: bigint[][];
  partial: bigint[];
  secondFull: bigint[][];
  diag: bigint[] | null;
}

const load = (p: Poseidon2Params): Params => ({
  firstFull: p.firstFull.map(row => row.map(BigInt)),
  partial: p.partial.map(BigInt),
  secondFull: p.secondFull.map(row => row.map(BigInt)),
  diag: p.diag === null ? null : p.diag.map(BigInt),
});

let cache: { t3: Params; t4: Params; t16: Params } | null = null;
function params() {
  if (cache === null) cache = { t3: load(POSEIDON2_T3), t4: load(POSEIDON2_T4), t16: load(POSEIDON2_T16) };
  return cache;
}

const sbox = (x: bigint): bigint => {
  const x2 = (x * x) % P;
  return (((x2 * x2) % P) * x) % P;
};

function mds4(s: bigint[], o: number): void {
  const a = s[o], b = s[o + 1], c = s[o + 2], d = s[o + 3];
  const t0 = a + b;
  const t1 = c + d;
  const t2 = 2n * b + t1;
  const t3 = 2n * d + t0;
  const t4 = 4n * t1 + t3;
  const t5 = 4n * t0 + t2;
  s[o] = (t3 + t5) % P;
  s[o + 1] = t5 % P;
  s[o + 2] = (t2 + t4) % P;
  s[o + 3] = t4 % P;
}

function external(s: bigint[]): void {
  const t = s.length;
  if (t === 3) {
    const sum = s[0] + s[1] + s[2];
    for (let i = 0; i < 3; i++) s[i] = (s[i] + sum) % P;
    return;
  }
  if (t === 4) {
    mds4(s, 0);
    return;
  }
  for (let o = 0; o < t; o += 4) mds4(s, o);
  const stored = [0n, 0n, 0n, 0n];
  for (let o = 0; o < t; o += 4) for (let j = 0; j < 4; j++) stored[j] += s[o + j];
  for (let o = 0; o < t; o += 4) for (let j = 0; j < 4; j++) s[o + j] = (s[o + j] + stored[j]) % P;
}

function internal(s: bigint[], diag: bigint[] | null): void {
  const sum = s.reduce((a, b) => a + b, 0n);
  if (diag === null) {
    // width 3: [[2,1,1],[1,2,1],[1,1,3]]
    s[0] = (s[0] + sum) % P;
    s[1] = (s[1] + sum) % P;
    s[2] = (2n * s[2] + sum) % P;
    return;
  }
  for (let i = 0; i < s.length; i++) s[i] = (s[i] * diag[i] + sum) % P;
}

function permute(input: readonly bigint[], p: Params): bigint[] {
  const s = input.map(v => {
    if (v < 0n || v >= P) throw new Error('Poseidon2 input is not a field element');
    return v;
  });
  external(s);
  for (const rc of p.firstFull) {
    for (let i = 0; i < s.length; i++) s[i] = sbox((s[i] + rc[i]) % P);
    external(s);
  }
  for (const rc of p.partial) {
    s[0] = sbox((s[0] + rc) % P);
    internal(s, p.diag);
  }
  for (const rc of p.secondFull) {
    for (let i = 0; i < s.length; i++) s[i] = sbox((s[i] + rc[i]) % P);
    external(s);
  }
  return s;
}

function sized(input: readonly bigint[], width: number): readonly bigint[] {
  if (input.length !== width) throw new Error(`Poseidon2 t${width} takes ${width} inputs, got ${input.length}`);
  return input;
}

export const poseidon2T3 = (input: readonly bigint[]): bigint[] => permute(sized(input, 3), params().t3);
export const poseidon2T4 = (input: readonly bigint[]): bigint[] => permute(sized(input, 4), params().t4);
export const poseidon2T16 = (input: readonly bigint[]): bigint[] => permute(sized(input, 16), params().t16);
