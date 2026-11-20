/**
 * The subset of CBOR (RFC 8949) the OPRF nodes speak: their messages are
 * serde structs written by ciborium 0.2, i.e. maps keyed by field name,
 * byte strings (points, field elements, the request id), unsigned integers,
 * arrays and text. Definite lengths only on the way out; on the way in,
 * anything outside this subset (negative integers, floats, tags, indefinite
 * lengths, non-text map keys, duplicate keys, trailing bytes) is refused, so a
 * message we cannot read exactly is an error rather than a guess.
 */

export type CborValue = number | bigint | string | boolean | null | Uint8Array | CborValue[] | { [key: string]: CborValue };

function head(major: number, n: number | bigint): number[] {
  const v = BigInt(n);
  if (v < 0n) throw new Error('CBOR: negative length/value');
  const m = major << 5;
  if (v < 24n) return [m | Number(v)];
  if (v < 0x100n) return [m | 24, Number(v)];
  if (v < 0x10000n) return [m | 25, Number(v >> 8n), Number(v & 0xffn)];
  if (v < 0x100000000n) return [m | 26, ...[24n, 16n, 8n, 0n].map(s => Number((v >> s) & 0xffn))];
  if (v < 1n << 64n) return [m | 27, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map(s => Number((v >> s) & 0xffn))];
  throw new Error('CBOR: value does not fit 64 bits');
}

function encodeInto(out: number[], value: CborValue): void {
  if (value === null) { out.push(0xf6); return; }
  if (value === true) { out.push(0xf5); return; }
  if (value === false) { out.push(0xf4); return; }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`CBOR: only non-negative safe integers are encoded, got ${value}`);
    out.push(...head(0, value));
    return;
  }
  if (typeof value === 'bigint') { out.push(...head(0, value)); return; }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    out.push(...head(3, bytes.length), ...bytes);
    return;
  }
  if (value instanceof Uint8Array) { out.push(...head(2, value.length), ...value); return; }
  if (Array.isArray(value)) {
    out.push(...head(4, value.length));
    for (const v of value) encodeInto(out, v);
    return;
  }
  const entries = Object.entries(value);
  out.push(...head(5, entries.length));
  for (const [k, v] of entries) {
    encodeInto(out, k);
    encodeInto(out, v);
  }
}

export function cborEncode(value: CborValue): Uint8Array {
  const out: number[] = [];
  encodeInto(out, value);
  return Uint8Array.from(out);
}

/** Additional info 24..27: the argument follows in 1, 2, 4 or 8 bytes. */
const ARGUMENT_BYTES: Readonly<Record<number, number>> = Object.freeze({ 24: 1, 25: 2, 26: 4, 27: 8 });

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error('CBOR: message ends early');
    return this.buf[this.pos++];
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('CBOR: message ends early');
    const s = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  arg(info: number): bigint {
    if (info < 24) return BigInt(info);
    const len = ARGUMENT_BYTES[info];
    if (len === undefined) throw new Error(`CBOR: unsupported additional info ${info} (indefinite lengths are refused)`);
    let v = 0n;
    for (const b of this.take(len)) v = (v << 8n) | BigInt(b);
    return v;
  }
  length(info: number): number {
    const v = this.arg(info);
    if (v > BigInt(this.buf.length)) throw new Error('CBOR: length exceeds the message');
    return Number(v);
  }
}

function decodeItem(r: Reader, depth: number): CborValue {
  if (depth > 32) throw new Error('CBOR: nested too deeply');
  const ib = r.byte();
  const major = ib >> 5;
  const info = ib & 0x1f;
  switch (major) {
    case 0: {
      const v = r.arg(info);
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    case 2: return r.take(r.length(info));
    case 3: {
      const bytes = r.take(r.length(info));
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    case 4: {
      const n = r.length(info);
      const arr: CborValue[] = [];
      for (let i = 0; i < n; i++) arr.push(decodeItem(r, depth + 1));
      return arr;
    }
    case 5: {
      const n = r.length(info);
      const obj: { [key: string]: CborValue } = Object.create(null);
      for (let i = 0; i < n; i++) {
        const k = decodeItem(r, depth + 1);
        if (typeof k !== 'string') throw new Error('CBOR: map key is not text');
        if (Object.prototype.hasOwnProperty.call(obj, k)) throw new Error(`CBOR: duplicate map key '${k}'`);
        obj[k] = decodeItem(r, depth + 1);
      }
      return obj;
    }
    case 7:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error(`CBOR: unsupported simple/float value ${info}`);
    default:
      throw new Error(`CBOR: unsupported major type ${major}`);
  }
}

export function cborDecode(bytes: Uint8Array): CborValue {
  const r = new Reader(bytes);
  const v = decodeItem(r, 0);
  if (r.pos !== bytes.length) throw new Error(`CBOR: ${bytes.length - r.pos} trailing bytes`);
  return v;
}
