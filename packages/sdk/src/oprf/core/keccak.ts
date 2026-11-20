// MIRROR of proofport-app-sdk/packages/core/src/oprf/keccak.ts (scripts/sync-oprf-mirror.mjs). Do not edit here.
/**
 * Keccak-256 (the Ethereum hash, original Keccak padding 0x01, not SHA3's
 * 0x06), with no dependencies so the OPRF client runs where ethers is not
 * installed. Held to ethers' keccak256 by the tests.
 */

const ROUND_CONSTANTS: readonly [number, number][] = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000], [0x80008000, 0x80000000],
  [0x0000808b, 0x00000000], [0x80000001, 0x00000000], [0x80008081, 0x80000000], [0x00008009, 0x80000000],
  [0x0000008a, 0x00000000], [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000], [0x00008003, 0x80000000],
  [0x00008002, 0x80000000], [0x00000080, 0x80000000], [0x0000800a, 0x00000000], [0x8000000a, 0x80000000],
  [0x80008081, 0x80000000], [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];

// Rotation offsets r[x + 5y] and the pi permutation, the standard tables.
const ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

function keccakF(lo: Uint32Array, hi: Uint32Array): void {
  const bLo = new Uint32Array(25);
  const bHi = new Uint32Array(25);
  const cLo = new Uint32Array(5);
  const cHi = new Uint32Array(5);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      cLo[x] = lo[x] ^ lo[x + 5] ^ lo[x + 10] ^ lo[x + 15] ^ lo[x + 20];
      cHi[x] = hi[x] ^ hi[x + 5] ^ hi[x + 10] ^ hi[x + 15] ^ hi[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const l1 = cLo[(x + 1) % 5];
      const h1 = cHi[(x + 1) % 5];
      const dLo = cLo[(x + 4) % 5] ^ ((l1 << 1) | (h1 >>> 31));
      const dHi = cHi[(x + 4) % 5] ^ ((h1 << 1) | (l1 >>> 31));
      for (let y = 0; y < 25; y += 5) {
        lo[x + y] ^= dLo;
        hi[x + y] ^= dHi;
      }
    }
    // rho and pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        const r = ROTATIONS[i];
        const l = lo[i];
        const h = hi[i];
        if (r === 0) {
          bLo[j] = l;
          bHi[j] = h;
        } else if (r < 32) {
          bLo[j] = (l << r) | (h >>> (32 - r));
          bHi[j] = (h << r) | (l >>> (32 - r));
        } else if (r === 32) {
          bLo[j] = h;
          bHi[j] = l;
        } else {
          const s = r - 32;
          bLo[j] = (h << s) | (l >>> (32 - s));
          bHi[j] = (l << s) | (h >>> (32 - s));
        }
      }
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        lo[y + x] = bLo[y + x] ^ (~bLo[y + ((x + 1) % 5)] & bLo[y + ((x + 2) % 5)]);
        hi[y + x] = bHi[y + x] ^ (~bHi[y + ((x + 1) % 5)] & bHi[y + ((x + 2) % 5)]);
      }
    }
    // iota
    lo[0] ^= ROUND_CONSTANTS[round][0];
    hi[0] ^= ROUND_CONSTANTS[round][1];
  }
}

const RATE = 136;

export function keccak256(data: Uint8Array): Uint8Array {
  const lo = new Uint32Array(25);
  const hi = new Uint32Array(25);
  const blocks = Math.floor(data.length / RATE) + 1;
  const padded = new Uint8Array(blocks * RATE);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < RATE / 8; i++) {
      const o = b * RATE + i * 8;
      lo[i] ^= padded[o] | (padded[o + 1] << 8) | (padded[o + 2] << 16) | (padded[o + 3] << 24);
      hi[i] ^= padded[o + 4] | (padded[o + 5] << 8) | (padded[o + 6] << 16) | (padded[o + 7] << 24);
    }
    keccakF(lo, hi);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 4; k++) {
      out[i * 8 + k] = (lo[i] >>> (8 * k)) & 0xff;
      out[i * 8 + 4 + k] = (hi[i] >>> (8 * k)) & 0xff;
    }
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * UTF-8 of a well-formed string. Written out rather than TextEncoder so the
 * module needs no Web API: TextEncoder turns a lone surrogate into U+FFFD
 * silently, and the callers here refuse one before they get this far.
 */
export function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`unpaired surrogate at index ${i}`);
      c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new Error(`unpaired surrogate at index ${i}`);
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}
