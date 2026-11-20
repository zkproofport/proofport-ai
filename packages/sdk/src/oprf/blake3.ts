/**
 * BLAKE3 (unkeyed hash mode, extendable output) for inputs of at most one
 * chunk (1024 bytes). That is the only size the OPRF nodes' nonce combiner
 * hashes (taceo-oprf-core 0.6.3 `combine_two_nonce_randomness`: a 22-byte
 * label, a 16-byte request id, 2 bytes per party, six 32-byte points), so the
 * tree mode for longer inputs is not implemented and a longer input throws.
 *
 * Held to the official test vectors (tests/fixtures/blake3-vectors.json).
 */

const IV = Uint32Array.of(
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
);
const MSG_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];

const CHUNK_START = 1;
const CHUNK_END = 2;
const ROOT = 8;

const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

function g(s: Uint32Array, a: number, b: number, c: number, d: number, mx: number, my: number): void {
  s[a] = (s[a] + s[b] + mx) >>> 0;
  s[d] = rotr(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotr(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b] + my) >>> 0;
  s[d] = rotr(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotr(s[b] ^ s[c], 7);
}

/** The compression function; returns all 16 output words. */
function compress(cv: Uint32Array, block: Uint32Array, counter: number, blockLen: number, flags: number): Uint32Array {
  const s = Uint32Array.of(
    cv[0], cv[1], cv[2], cv[3], cv[4], cv[5], cv[6], cv[7],
    IV[0], IV[1], IV[2], IV[3],
    counter >>> 0, Math.floor(counter / 0x100000000) >>> 0, blockLen, flags,
  );
  let m = Uint32Array.from(block);
  for (let round = 0; round < 7; round++) {
    g(s, 0, 4, 8, 12, m[0], m[1]);
    g(s, 1, 5, 9, 13, m[2], m[3]);
    g(s, 2, 6, 10, 14, m[4], m[5]);
    g(s, 3, 7, 11, 15, m[6], m[7]);
    g(s, 0, 5, 10, 15, m[8], m[9]);
    g(s, 1, 6, 11, 12, m[10], m[11]);
    g(s, 2, 7, 8, 13, m[12], m[13]);
    g(s, 3, 4, 9, 14, m[14], m[15]);
    if (round < 6) m = Uint32Array.from(MSG_PERMUTATION, i => m[i]);
  }
  for (let i = 0; i < 8; i++) {
    s[i] ^= s[i + 8];
    s[i + 8] ^= cv[i];
  }
  return s;
}

function wordsOf(bytes: Uint8Array): Uint32Array {
  const w = new Uint32Array(16);
  for (let i = 0; i < bytes.length; i++) w[i >> 2] |= bytes[i] << (8 * (i & 3));
  return w;
}

/**
 * BLAKE3(input) with `outLen` bytes of extended output.
 * @throws for an input longer than one chunk (1024 bytes) or a bad length.
 */
export function blake3(input: Uint8Array, outLen = 32): Uint8Array {
  if (input.length > CHUNK_LEN) {
    throw new Error(`blake3 here hashes at most ${CHUNK_LEN} bytes (one chunk); got ${input.length}.`);
  }
  if (!Number.isSafeInteger(outLen) || outLen < 0) throw new Error(`blake3 output length must be a non-negative integer, got ${outLen}.`);
  // Split into 64-byte blocks; an empty input is one empty block.
  const blockCount = Math.max(1, Math.ceil(input.length / BLOCK_LEN));
  let cv: Uint32Array = IV.slice();
  for (let b = 0; b < blockCount - 1; b++) {
    const block = wordsOf(input.subarray(b * BLOCK_LEN, (b + 1) * BLOCK_LEN));
    const flags = b === 0 ? CHUNK_START : 0;
    cv = compress(cv, block, 0, BLOCK_LEN, flags).slice(0, 8);
  }
  const lastBytes = input.subarray((blockCount - 1) * BLOCK_LEN);
  const lastBlock = wordsOf(lastBytes);
  const lastFlags = (blockCount === 1 ? CHUNK_START : 0) | CHUNK_END | ROOT;
  // Root output: the last block's compression with an increasing output counter.
  const out = new Uint8Array(outLen);
  for (let counter = 0, pos = 0; pos < outLen; counter++) {
    const words = compress(cv, lastBlock, counter, lastBytes.length, lastFlags);
    for (let i = 0; i < 16 && pos < outLen; i++) {
      for (let k = 0; k < 4 && pos < outLen; k++) out[pos++] = (words[i] >>> (8 * k)) & 0xff;
    }
  }
  return out;
}
