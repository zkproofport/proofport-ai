/**
 * The OPRF client's own primitives: BLAKE3 (official vectors), the CBOR
 * subset (cbor-x as the oracle, plus every refusal), arkworks' compressed
 * point form and the Lagrange coefficients.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { encode as cborxEncode, decode as cborxDecode } from 'cbor-x';
import { blake3 } from '../packages/sdk/src/oprf/blake3.js';
import { cborDecode, cborEncode } from '../packages/sdk/src/oprf/cbor.js';
import { compressPoint, decompressPoint, decodeScalar, lagrangeAtZero, combineCommitments } from '../packages/sdk/src/oprf/shamir.js';
import { GENERATOR, scalarMul, negate } from '../packages/sdk/src/oprf/core/babyjubjub.js';
import { P, R, mod } from '../packages/sdk/src/oprf/core/field.js';

const B3 = createRequire(import.meta.url)('./fixtures/blake3-vectors.json') as { cases: { input_len: number; hash: string }[] };
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

describe('BLAKE3 (single chunk, XOF)', () => {
  it.each(B3.cases.map(c => [c.input_len, c.hash]))('official vector, input %i bytes, 131-byte output', (len, hash) => {
    expect(hex(blake3(pattern(len as number), 131))).toBe(hash);
    expect(hex(blake3(pattern(len as number), 64))).toBe((hash as string).slice(0, 128));
  });

  it('refuses more than one chunk rather than hashing it wrong', () => {
    expect(() => blake3(pattern(1025))).toThrow(/at most 1024 bytes/);
  });

  it.each([[-1], [1.5], [NaN]])('refuses output length %s', n => {
    expect(() => blake3(pattern(3), n as number)).toThrow(/output length/);
  });
});

describe('CBOR subset', () => {
  const sample = {
    request_id: Uint8Array.from({ length: 16 }, (_, i) => i),
    blinded_query: new Uint8Array(32).fill(7),
    auth: { api_key: 'k 한국 🔐' },
    contributing_parties: [1, 3, 65535],
    big: 2n ** 40n,
    small: 23, b1: 24, b2: 255, b3: 256, b4: 65536, b8: 2 ** 32,
    flags: [true, false, null],
  };

  it('what we encode, cbor-x decodes to the same values', () => {
    const back = cborxDecode(Buffer.from(cborEncode(sample)));
    expect(new Uint8Array(back.request_id)).toEqual(sample.request_id);
    expect(back.auth).toEqual(sample.auth);
    expect(back.contributing_parties).toEqual(sample.contributing_parties);
    expect(BigInt(back.big)).toBe(sample.big);
    // cbor-x reads an 8-byte head as a bigint; the value is what counts.
    expect([back.small, back.b1, back.b2, back.b3, back.b4, back.b8].map(Number)).toEqual([23, 24, 255, 256, 65536, 2 ** 32]);
    expect(back.flags).toEqual([true, false, null]);
  });

  it('what cbor-x encodes (definite, text keys), we decode to the same values', () => {
    const bytes = new Uint8Array(cborxEncode({ party_id: 2, key: Buffer.from([1, 2, 3]), epoch: 4294967295, list: [1, 2] }));
    const v = cborDecode(bytes) as Record<string, unknown>;
    expect(v.party_id).toBe(2);
    expect(v.key).toEqual(Uint8Array.of(1, 2, 3));
    expect(v.epoch).toBe(4294967295);
    expect(v.list).toEqual([1, 2]);
  });

  it.each([
    ['trailing bytes', Uint8Array.of(0x01, 0x02), /trailing/],
    ['truncated byte string', Uint8Array.of(0x42, 0x01), /ends early/],
    ['indefinite-length map', Uint8Array.of(0xbf, 0xff), /indefinite/],
    ['negative integer', Uint8Array.of(0x20), /major type 1/],
    ['tag', Uint8Array.of(0xc0, 0x00), /major type 6/],
    ['float', Uint8Array.of(0xf9, 0x3c, 0x00), /simple\/float/],
    ['non-text map key', Uint8Array.of(0xa1, 0x01, 0x02), /not text/],
    ['duplicate key', Uint8Array.of(0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02), /duplicate/],
    ['invalid UTF-8 text', Uint8Array.of(0x61, 0xff), /./],
    ['length beyond the message', Uint8Array.of(0x5b, 0, 0, 0, 1, 0, 0, 0, 0), /exceeds|ends early/],
    ['empty message', new Uint8Array(0), /ends early/],
  ])('refuses %s', (_label, bytes, re) => {
    expect(() => cborDecode(bytes as Uint8Array)).toThrow(re as RegExp);
  });

  it('refuses to nest beyond 32 levels', () => {
    const deep = new Uint8Array(40).fill(0x81);
    expect(() => cborDecode(Uint8Array.of(...deep, 0x00))).toThrow(/nested too deeply/);
  });

  it.each([[-1], [1.5], [Number.MAX_SAFE_INTEGER + 2]])('refuses to encode %s', n => {
    expect(() => cborEncode(n as number)).toThrow();
  });
});

describe('compressed BabyJubJub points (arkworks form)', () => {
  const pts = [GENERATOR, scalarMul(GENERATOR, 12345n), negate(scalarMul(GENERATOR, 999n)), { x: 0n, y: 1n }];

  it.each(pts.map((p, i) => [i, p]))('round-trips point %i, x sign in the top bit', (_i, p) => {
    const bytes = compressPoint(p as { x: bigint; y: bigint });
    expect(bytes).toHaveLength(32);
    expect(Boolean(bytes[31] & 0x80)).toBe((p as { x: bigint }).x > (P - 1n) / 2n);
    expect(decompressPoint(bytes, 'p')).toEqual(p);
  });

  it('refuses y at or above p', () => {
    const b = new Uint8Array(32).fill(0xff);
    b[31] = 0x7f;
    expect(() => decompressPoint(b, 'p')).toThrow(/not below the field modulus/);
  });

  it('refuses a y with no point on the curve', () => {
    let y = 2n;
    for (;; y++) {
      const b = new Uint8Array(32);
      let v = y;
      for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
      try { decompressPoint(b, 'p'); } catch (e) {
        if (/not a point of BabyJubJub/.test((e as Error).message)) return;
      }
    }
  });

  it('refuses a curve point outside the prime-order subgroup (low-order point)', () => {
    // (0, -1) has order 2.
    const b = new Uint8Array(32);
    let v = P - 1n;
    for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
    expect(() => decompressPoint(b, 'p')).toThrow(/subgroup/);
  });

  it.each([[new Uint8Array(31)], [new Uint8Array(33)], ['00'], [null]])('refuses a non-32-byte encoding %#', v => {
    expect(() => decompressPoint(v, 'p')).toThrow(/32-byte compressed point/);
  });

  it('scalars: below r accepted, r refused', () => {
    const le = (x: bigint) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
    expect(decodeScalar(le(R - 1n), 's')).toBe(R - 1n);
    expect(() => decodeScalar(le(R), 's')).toThrow(/below the subgroup order/);
  });
});

describe('Lagrange coefficients and commitment combination', () => {
  it('interpolate a degree-1 polynomial at 0 from any two of three parties', () => {
    const f = (x: bigint) => mod(42n + 7n * x, R);
    for (const ids of [[1, 2], [1, 3], [2, 3]]) {
      const v = ids.reduce((acc, i) => mod(acc + lagrangeAtZero(i, ids) * f(BigInt(i)), R), 0n);
      expect(v).toBe(42n);
    }
  });

  it('refuses two answers with the same party id', () => {
    const c = { c: GENERATOR, d1: GENERATOR, d2: GENERATOR, e1: GENERATOR, e2: GENERATOR };
    expect(() => combineCommitments([c, c], [1, 1])).toThrow(/same party id/);
  });

  it('refuses a party id that is not a u16', () => {
    const c = { c: GENERATOR, d1: GENERATOR, d2: GENERATOR, e1: GENERATOR, e2: GENERATOR };
    expect(() => combineCommitments([c], [-1])).toThrow(/u16/);
    expect(() => combineCommitments([c], [65535])).toThrow(/u16/);
  });
});
