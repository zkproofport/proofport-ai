/**
 * Unit tests for extractDomainFromPublicInputs and extractNullifierFromPublicInputs.
 *
 * These functions parse oidc_domain_attestation proof publicInputs (148 x 32-byte fields).
 */
import { describe, it, expect } from 'vitest';
import {
  extractDomainFromPublicInputs,
  extractNullifierFromPublicInputs,
} from '../packages/sdk/src/extract.js';

/**
 * Build a 148-field publicInputs hex string.
 * Each field is 32 bytes (64 hex chars). Total = 148 * 64 = 9472 hex chars + "0x" prefix.
 */
function buildPublicInputsHex(opts: {
  domain: string;
  nullifierBytes?: number[];
}): string {
  const fields: string[] = new Array(148).fill('00'.repeat(32));

  // Domain bytes at field indices 18..18+domain.length
  for (let i = 0; i < opts.domain.length; i++) {
    const byte = opts.domain.charCodeAt(i).toString(16).padStart(2, '0');
    fields[18 + i] = '00'.repeat(31) + byte;
  }

  // Domain length at field index 82
  const lenHex = opts.domain.length.toString(16).padStart(2, '0');
  fields[82] = '00'.repeat(31) + lenHex;

  // Nullifier at field indices 115..147
  if (opts.nullifierBytes) {
    for (let i = 0; i < opts.nullifierBytes.length && i < 32; i++) {
      const byte = opts.nullifierBytes[i].toString(16).padStart(2, '0');
      fields[115 + i] = '00'.repeat(31) + byte;
    }
  }

  return '0x' + fields.join('');
}

describe('extractDomainFromPublicInputs', () => {
  it('extracts domain from valid 148-field publicInputs', () => {
    const hex = buildPublicInputsHex({ domain: 'example.com' });
    expect(extractDomainFromPublicInputs(hex)).toBe('example.com');
  });

  it('extracts single-char domain', () => {
    const hex = buildPublicInputsHex({ domain: 'x' });
    expect(extractDomainFromPublicInputs(hex)).toBe('x');
  });

  it('extracts max-length domain (64 chars)', () => {
    const domain = 'a'.repeat(64);
    const hex = buildPublicInputsHex({ domain });
    expect(extractDomainFromPublicInputs(hex)).toBe(domain);
  });

  it('returns null for too-short hex string (fewer than 83 fields)', () => {
    // 82 fields = 82 * 64 = 5248 hex chars
    const shortHex = '0x' + '00'.repeat(32 * 82);
    expect(extractDomainFromPublicInputs(shortHex)).toBeNull();
  });

  it('returns null when domain length is 0', () => {
    const fields: string[] = new Array(148).fill('00'.repeat(32));
    // field 82 = 0 (domain len = 0)
    const hex = '0x' + fields.join('');
    expect(extractDomainFromPublicInputs(hex)).toBeNull();
  });

  it('returns null when domain length exceeds 64', () => {
    const fields: string[] = new Array(148).fill('00'.repeat(32));
    // field 82 = 65 (exceeds max)
    fields[82] = '00'.repeat(31) + '41'; // 0x41 = 65
    const hex = '0x' + fields.join('');
    expect(extractDomainFromPublicInputs(hex)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractDomainFromPublicInputs('')).toBeNull();
  });

  it('returns null for malformed hex', () => {
    expect(extractDomainFromPublicInputs('not-hex')).toBeNull();
  });

  it('works without 0x prefix', () => {
    const hex = buildPublicInputsHex({ domain: 'test.org' });
    // Strip the 0x prefix
    const noPrefix = hex.slice(2);
    expect(extractDomainFromPublicInputs(noPrefix)).toBe('test.org');
  });

  it('uses domain len field (index 82) not string terminator', () => {
    // Set domain bytes for "hello.world" but domain len to 5 -> should return "hello"
    const fields: string[] = new Array(148).fill('00'.repeat(32));
    const fullDomain = 'hello.world';
    for (let i = 0; i < fullDomain.length; i++) {
      const byte = fullDomain.charCodeAt(i).toString(16).padStart(2, '0');
      fields[18 + i] = '00'.repeat(31) + byte;
    }
    // Set len to 5 instead of 11
    fields[82] = '00'.repeat(31) + '05';
    const hex = '0x' + fields.join('');
    expect(extractDomainFromPublicInputs(hex)).toBe('hello');
  });
});

describe('extractNullifierFromPublicInputs', () => {
  it('extracts nullifier from valid 148-field publicInputs', () => {
    const nullifierBytes = Array.from({ length: 32 }, (_, i) => i + 1);
    const hex = buildPublicInputsHex({ domain: 'example.com', nullifierBytes });

    const result = extractNullifierFromPublicInputs(hex);
    expect(result).toBe(
      '0x' + nullifierBytes.map((b) => b.toString(16).padStart(2, '0')).join(''),
    );
  });

  it('returns null for too-short hex string (fewer than 128 fields)', () => {
    // 50 fields — too short for any circuit's nullifier
    const shortHex = '0x' + '00'.repeat(32 * 50);
    expect(extractNullifierFromPublicInputs(shortHex)).toBeNull();
  });

  it('extracts zero nullifier when all nullifier fields are 0', () => {
    const hex = buildPublicInputsHex({ domain: 'example.com' });
    const result = extractNullifierFromPublicInputs(hex);
    expect(result).toBe('0x' + '00'.repeat(32));
  });

  it('returns null for empty string', () => {
    expect(extractNullifierFromPublicInputs('')).toBeNull();
  });

  it('returns null for malformed hex', () => {
    expect(extractNullifierFromPublicInputs('not-hex')).toBeNull();
  });

  it('extracts correct bytes from specific nullifier pattern', () => {
    const nullifierBytes = Array.from({ length: 32 }, () => 0xab);
    const hex = buildPublicInputsHex({ domain: 'a', nullifierBytes });
    const result = extractNullifierFromPublicInputs(hex);
    expect(result).toBe('0x' + 'ab'.repeat(32));
  });
});
