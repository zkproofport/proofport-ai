/**
 * Unit tests for the publicInputs extractors.
 *
 * These parse the flat 32-byte-per-field public-input vector a circuit emits.
 * Every extractor takes the circuit explicitly — there is no longer a
 * `detectCircuit(fieldCount)` inferring identity from length. The last section
 * of this file is the regression guard for that removal.
 */
import { describe, it, expect } from 'vitest';
import {
  extractDomainFromPublicInputs,
  extractNullifierFromPublicInputs,
  extractScopeFromPublicInputs,
  extractOprfDomainFromPublicInputs,
  extractOprfKeyHashFromPublicInputs,
} from '../packages/sdk/src/extract.js';
import { CIRCUIT_IDS } from '../packages/sdk/src/circuits.js';

const OIDC = CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION;
const KYC = CIRCUIT_IDS.COINBASE_ATTESTATION;
const COUNTRY = CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION;

/** A single field: a 32-byte big-endian value holding one byte in its low bits. */
function field(byte: number): string {
  return '00'.repeat(31) + byte.toString(16).padStart(2, '0');
}

/**
 * Build a 148-field oidc_domain_attestation publicInputs hex string.
 * Each field is 32 bytes (64 hex chars). Total = 148 * 64 = 9472 hex chars + "0x".
 */
function buildPublicInputsHex(opts: {
  domain: string;
  nullifierBytes?: number[];
}): string {
  const fields: string[] = new Array(148).fill('00'.repeat(32));

  // Domain bytes at field indices 18..18+domain.length
  for (let i = 0; i < opts.domain.length; i++) {
    fields[18 + i] = field(opts.domain.charCodeAt(i));
  }

  // Domain length at field index 82
  fields[82] = field(opts.domain.length);

  // Nullifier at field indices 115..146
  if (opts.nullifierBytes) {
    for (let i = 0; i < opts.nullifierBytes.length && i < 32; i++) {
      fields[115 + i] = field(opts.nullifierBytes[i]);
    }
  }

  return '0x' + fields.join('');
}

/**
 * A wallet circuit's publicInputs since the OPRF nullifier: `count` fields,
 * oprf_key_hash, domain, scope, nullifier as ONE field each from `start`
 * (coinbase_attestation v2: 133 fields, 128..131).
 */
function buildCoinbasePublicInputsHex(opts: {
  keyHash?: bigint; domain?: bigint; scope?: bigint; nullifier?: bigint;
  /** Bytes to place at indices 18.. — where OIDC keeps its domain storage. */
  bytesAtOidcDomainSlot?: string;
  /** Value to place at index 82 — where OIDC keeps its domain length. */
  oidcDomainLenSlot?: number;
  fieldCount?: number;
  start?: number;
} = {}): string {
  const fields: string[] = new Array(opts.fieldCount ?? 133).fill('00'.repeat(32));
  const start = opts.start ?? 128;
  const put = (i: number, v: bigint | undefined) => { if (v !== undefined && i < fields.length) fields[i] = v.toString(16).padStart(64, '0'); };
  put(start, opts.keyHash);
  put(start + 1, opts.domain);
  put(start + 2, opts.scope);
  put(start + 3, opts.nullifier);
  if (opts.bytesAtOidcDomainSlot) {
    for (let i = 0; i < opts.bytesAtOidcDomainSlot.length; i++) {
      fields[18 + i] = field(opts.bytesAtOidcDomainSlot.charCodeAt(i));
    }
  }
  if (opts.oidcDomainLenSlot !== undefined) {
    fields[82] = field(opts.oidcDomainLenSlot);
  }
  return '0x' + fields.join('');
}

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const h64 = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
const ONE_EACH = { keyHash: 0x0aan, domain: 0x0bbn, scope: 0x0ccn, nullifier: P - 1n };

describe('extractDomainFromPublicInputs', () => {
  it('extracts domain from valid 148-field publicInputs', () => {
    const hex = buildPublicInputsHex({ domain: 'example.com' });
    expect(extractDomainFromPublicInputs(hex, OIDC)).toBe('example.com');
  });

  it('extracts single-char domain', () => {
    const hex = buildPublicInputsHex({ domain: 'x' });
    expect(extractDomainFromPublicInputs(hex, OIDC)).toBe('x');
  });

  it('extracts max-length domain (64 chars)', () => {
    const domain = 'a'.repeat(64);
    const hex = buildPublicInputsHex({ domain });
    expect(extractDomainFromPublicInputs(hex, OIDC)).toBe(domain);
  });

  it('returns null for too-short hex string (fewer than 83 fields)', () => {
    // 82 fields = 82 * 64 = 5248 hex chars
    const shortHex = '0x' + '00'.repeat(32 * 82);
    expect(extractDomainFromPublicInputs(shortHex, OIDC)).toBeNull();
  });

  it('returns null when domain length is 0', () => {
    const fields: string[] = new Array(148).fill('00'.repeat(32));
    // field 82 = 0 (domain len = 0)
    const hex = '0x' + fields.join('');
    expect(extractDomainFromPublicInputs(hex, OIDC)).toBeNull();
  });

  it('returns null when domain length exceeds 64', () => {
    const fields: string[] = new Array(148).fill('00'.repeat(32));
    // field 82 = 65 (exceeds max)
    fields[82] = '00'.repeat(31) + '41'; // 0x41 = 65
    const hex = '0x' + fields.join('');
    expect(extractDomainFromPublicInputs(hex, OIDC)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractDomainFromPublicInputs('', OIDC)).toBeNull();
  });

  it('returns null for malformed hex', () => {
    expect(extractDomainFromPublicInputs('not-hex', OIDC)).toBeNull();
  });

  it('works without 0x prefix', () => {
    const hex = buildPublicInputsHex({ domain: 'test.org' });
    // Strip the 0x prefix
    const noPrefix = hex.slice(2);
    expect(extractDomainFromPublicInputs(noPrefix, OIDC)).toBe('test.org');
  });

  it('uses domain len field (index 82) not string terminator', () => {
    // Set domain bytes for "hello.world" but domain len to 5 -> should return "hello"
    const fields: string[] = new Array(148).fill('00'.repeat(32));
    const fullDomain = 'hello.world';
    for (let i = 0; i < fullDomain.length; i++) {
      fields[18 + i] = field(fullDomain.charCodeAt(i));
    }
    // Set len to 5 instead of 11
    fields[82] = field(5);
    const hex = '0x' + fields.join('');
    expect(extractDomainFromPublicInputs(hex, OIDC)).toBe('hello');
  });

  it('returns null for circuits that carry no domain', () => {
    const hex = buildPublicInputsHex({ domain: 'example.com' });
    expect(extractDomainFromPublicInputs(hex, KYC)).toBeNull();
    expect(extractDomainFromPublicInputs(hex, COUNTRY)).toBeNull();
  });
});

describe('extractNullifierFromPublicInputs', () => {
  it('extracts nullifier from valid 148-field publicInputs', () => {
    const nullifierBytes = Array.from({ length: 32 }, (_, i) => i + 1);
    const hex = buildPublicInputsHex({ domain: 'example.com', nullifierBytes });

    const result = extractNullifierFromPublicInputs(hex, OIDC);
    expect(result).toBe(
      '0x' + nullifierBytes.map((b) => b.toString(16).padStart(2, '0')).join(''),
    );
  });

  it('returns null for too-short hex string (fewer than 128 fields)', () => {
    // 50 fields — too short for any circuit's nullifier
    const shortHex = '0x' + '00'.repeat(32 * 50);
    expect(extractNullifierFromPublicInputs(shortHex, OIDC)).toBeNull();
    expect(extractNullifierFromPublicInputs(shortHex, KYC)).toBeNull();
  });

  it('extracts zero nullifier when all nullifier fields are 0', () => {
    const hex = buildPublicInputsHex({ domain: 'example.com' });
    const result = extractNullifierFromPublicInputs(hex, OIDC);
    expect(result).toBe('0x' + '00'.repeat(32));
  });

  it('returns null for empty string', () => {
    expect(extractNullifierFromPublicInputs('', OIDC)).toBeNull();
  });

  it('returns null for malformed hex', () => {
    expect(extractNullifierFromPublicInputs('not-hex', OIDC)).toBeNull();
  });

  it('extracts correct bytes from specific nullifier pattern', () => {
    const nullifierBytes = Array.from({ length: 32 }, () => 0xab);
    const hex = buildPublicInputsHex({ domain: 'a', nullifierBytes });
    const result = extractNullifierFromPublicInputs(hex, OIDC);
    expect(result).toBe('0x' + 'ab'.repeat(32));
  });

});

describe('wallet circuits: one field each for oprf_key_hash, domain, scope, nullifier', () => {
  it.each([
    ['coinbase_attestation', 133, 128],
    ['coinbase_country_attestation', 155, 150],
    ['giwa_attestation', 132, 128],
    ['human_passport_score', 135, 128],
  ] as const)('%s: %i fields, OPRF values from %i', (circuit, count, start) => {
    const hex = buildCoinbasePublicInputsHex({ ...ONE_EACH, fieldCount: count, start });
    expect(extractScopeFromPublicInputs(hex, circuit)).toBe(h64(0x0ccn));
    expect(extractNullifierFromPublicInputs(hex, circuit)).toBe(h64(P - 1n));
    expect(extractOprfDomainFromPublicInputs(hex, circuit)).toBe(h64(0x0bbn));
    expect(extractOprfKeyHashFromPublicInputs(hex, circuit)).toBe(h64(0x0aan));
  });

  it.each([
    ['coinbase_attestation', 193], ['coinbase_attestation', 132], ['coinbase_attestation', 134],
    ['coinbase_country_attestation', 215], ['giwa_attestation', 192], ['human_passport_score', 195],
  ] as const)('%s: a %i-field vector (superseded layout or off by one) reads as unknown', (circuit, count) => {
    const hex = buildCoinbasePublicInputsHex({ ...ONE_EACH, fieldCount: count });
    expect(extractScopeFromPublicInputs(hex, circuit)).toBeNull();
    expect(extractNullifierFromPublicInputs(hex, circuit)).toBeNull();
    expect(extractOprfDomainFromPublicInputs(hex, circuit)).toBeNull();
    expect(extractOprfKeyHashFromPublicInputs(hex, circuit)).toBeNull();
  });

  it('a value at or above p is not a field and reads as unknown, never reduced', () => {
    expect(extractNullifierFromPublicInputs(buildCoinbasePublicInputsHex({ ...ONE_EACH, nullifier: P }), KYC)).toBeNull();
    expect(extractScopeFromPublicInputs(buildCoinbasePublicInputsHex({ ...ONE_EACH, scope: 2n ** 256n - 1n }), KYC)).toBeNull();
  });

  it('non-hex inside the vector reads as unknown', () => {
    const hex = buildCoinbasePublicInputsHex(ONE_EACH).replace(/0{64}$/, 'zz'.repeat(32));
    expect(extractNullifierFromPublicInputs(hex, KYC)).toBeNull();
  });

  it('OIDC still reads its 32-byte scope at 83-114', () => {
    const fields: string[] = new Array(148).fill('00'.repeat(32));
    for (let i = 83; i <= 114; i++) fields[i] = field(0x22);
    expect(extractScopeFromPublicInputs('0x' + fields.join(''), OIDC)).toBe('0x' + '22'.repeat(32));
  });

  it('OIDC carries no OPRF domain or key hash', () => {
    const hex = buildPublicInputsHex({ domain: 'example.com' });
    expect(extractOprfDomainFromPublicInputs(hex, OIDC)).toBeNull();
    expect(extractOprfKeyHashFromPublicInputs(hex, OIDC)).toBeNull();
  });
});

describe('no circuit is inferred from field count (regression: detectCircuit removed)', () => {
  it('does not read a domain out of a coinbase proof', () => {
    // 128 fields clears the old `fields.length < 83` guard, and the bytes that
    // happen to sit at indices 18.. and 82 used to be read as a domain. The old
    // implementation returned "coinbase" here; the current one returns null
    // because the caller said this is not an OIDC proof.
    const hex = buildCoinbasePublicInputsHex({
      bytesAtOidcDomainSlot: 'coinbase',
      oidcDomainLenSlot: 8,
    });
    expect(extractDomainFromPublicInputs(hex, KYC)).toBeNull();
  });

  it('does not fall back to the coinbase layout for a circuit with no layout', () => {
    // The old code did `LAYOUTS[ct] || LAYOUTS.coinbase_attestation`, so a
    // canonical-but-unprovable id silently read coinbase's byte ranges and
    // returned a plausible 32-byte value.
    const hex = buildCoinbasePublicInputsHex(ONE_EACH);
    const unprovable = CIRCUIT_IDS.DOJANG_PLAYGROUND as unknown as typeof KYC;

    expect(extractNullifierFromPublicInputs(hex, unprovable)).toBeNull();
    expect(extractScopeFromPublicInputs(hex, unprovable)).toBeNull();
    expect(extractDomainFromPublicInputs(hex, unprovable)).toBeNull();
  });

  it('answers "I don\'t know" when a JavaScript caller omits the circuit', () => {
    // TypeScript callers get a compile error. Untyped callers used to get a
    // guess; they now get null.
    const hex = buildCoinbasePublicInputsHex(ONE_EACH);
    const loose = extractNullifierFromPublicInputs as unknown as (pi: string) => string | null;
    expect(loose(hex)).toBeNull();
  });

  it('rejects a hyphenated route name rather than treating it as a circuit', () => {
    const hex = buildCoinbasePublicInputsHex(ONE_EACH);
    const notAnId = 'coinbase-kyc' as unknown as typeof KYC;
    expect(extractNullifierFromPublicInputs(hex, notAnId)).toBeNull();
  });
});
