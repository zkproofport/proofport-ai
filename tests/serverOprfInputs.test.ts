/**
 * readOprfInputs: the eleven OPRF values of a wallet credential request,
 * checked before payment (src/input/oprfInputs.ts), and formatOprfInputs
 * (what reaches noir_js).
 *
 * Matrix (per key unless stated):
 *   empty/null      missing, null, '', whitespace, number, boolean, array, object
 *   shape           63 and 65 hex digits, no 0x, 0X, non-hex, hostile text,
 *                   UTF-8 (Korean, emoji), embedded newline
 *   boundary        Fields: p-1 accepted, p and 2^256-1 refused (never reduced);
 *                   beta / s: r-1 accepted, r refused; beta 0 refused, s 0 accepted
 *   case            uppercase hex accepted and lower-cased
 *   key hash        off by one digit / another valid Field refused
 *                   (OPRF_KEY_HASH_MISMATCH); production / unset env / unknown
 *                   circuit / OIDC refused before any value is read
 *   formatter       exactly the eleven circuit names, values untouched;
 *                   missing oprf / missing key throws
 */
import { describe, expect, it } from 'vitest';
import {
  OPRF_FIELD_MODULUS,
  OPRF_INPUT_KEYS,
  OPRF_SCALAR_ORDER,
  OprfInputRefusal,
  readOprfInputs,
} from '../src/input/oprfInputs.js';
import { formatOprfInputs } from '../src/prover/inputFormatter.js';
import { NETWORK, oprfParams, oprfWireInputs } from './helpers/oprfInputs.js';

const hex = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
const P = OPRF_FIELD_MODULUS;
const R = OPRF_SCALAR_ORDER;
const SCALAR_KEYS = ['oprf_beta', 'oprf_dlog_s'] as const;
const FIELD_KEYS = OPRF_INPUT_KEYS.filter(k => !(SCALAR_KEYS as readonly string[]).includes(k));

function refusal(fn: () => unknown): OprfInputRefusal {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OprfInputRefusal);
    return e as OprfInputRefusal;
  }
  throw new Error('expected a refusal');
}

const read = (inputs: unknown, env: 'staging' | 'local' | 'production' | undefined = 'staging', circuit = 'coinbase_attestation') =>
  readOprfInputs(env, circuit, inputs);

describe('readOprfInputs accepts', () => {
  it.each(['coinbase_attestation', 'coinbase_country_attestation', 'giwa_attestation', 'human_passport_score'])(
    'the recorded network answer for %s in staging and local', (circuit) => {
      expect(read(oprfWireInputs(), 'staging', circuit)).toEqual(oprfParams());
      expect(read(oprfWireInputs(), 'local', circuit)).toEqual(oprfParams());
    });

  it('exactly the eleven keys, ignoring others', () => {
    const out = read({ ...oprfWireInputs(), scope_bytes: '0x00', extra: 1 });
    expect(Object.keys(out).sort()).toEqual([...OPRF_INPUT_KEYS].sort());
  });

  it('uppercase hex, returned lower-cased', () => {
    const upper = Object.fromEntries(Object.entries(oprfWireInputs()).map(([k, v]) => [k, '0x' + (v as string).slice(2).toUpperCase()]));
    expect(read(upper)).toEqual(oprfParams());
  });

  it.each(FIELD_KEYS.filter(k => k !== 'oprf_key_hash'))('%s = p - 1 (never reduced, the largest Field)', (key) => {
    expect(read(oprfWireInputs({ [key]: hex(P - 1n) }))[key]).toBe(hex(P - 1n));
  });

  it.each(SCALAR_KEYS)('%s = r - 1', (key) => {
    expect(read(oprfWireInputs({ [key]: hex(R - 1n) }))[key]).toBe(hex(R - 1n));
  });

  it('oprf_dlog_s = 0 (the circuit decides) and Field 0 values', () => {
    expect(read(oprfWireInputs({ oprf_dlog_s: hex(0n) })).oprf_dlog_s).toBe(hex(0n));
    expect(read(oprfWireInputs({ nullifier: hex(0n) })).nullifier).toBe(hex(0n));
  });
});

describe('readOprfInputs refuses a malformed value, naming the key', () => {
  const BAD: [string, unknown][] = [
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
    ['a number', 12345],
    ['a bigint-like number', 1e77],
    ['a boolean', true],
    ['an array', ['0x' + '11'.repeat(32)]],
    ['an object', { x: 1 }],
    ['63 hex digits', '0x' + '1'.repeat(63)],
    ['65 hex digits', '0x' + '1'.repeat(65)],
    ['no 0x', '11'.repeat(32)],
    ['0X prefix', '0X' + '11'.repeat(32)],
    ['non-hex', '0x' + 'zz'.repeat(32)],
    ['padded with spaces', ' 0x' + '11'.repeat(32) + ' '],
    ['a trailing newline', '0x' + '11'.repeat(32) + '\n'],
    ['Korean', '0x' + '한'.repeat(64)],
    ['emoji', '0x' + '🔐'.repeat(32)],
    ['HTML', '<script>alert(1)</script>'],
    ['SQL', "0x' OR 1=1 --"],
    ['wildcards', '0x%_\\' + '1'.repeat(60)],
    ['a decimal string', '1234'],
  ];
  for (const key of OPRF_INPUT_KEYS) {
    it.each(BAD)(`${key}: %s`, (_name, value) => {
      const inputs = oprfWireInputs();
      if (value === undefined) delete inputs[key];
      else inputs[key] = value;
      const e = refusal(() => read(inputs));
      expect(e.code).toBe('INVALID_REQUEST');
      expect(e.message).toContain(key);
    });
  }

  it.each(FIELD_KEYS)('%s = p and 2^256 - 1 (never reduced)', (key) => {
    for (const v of [P, (1n << 256n) - 1n]) {
      const e = refusal(() => read(oprfWireInputs({ [key]: hex(v) })));
      expect(e.code).toBe('INVALID_REQUEST');
      expect(e.message).toBe(`${key} is not below the field modulus p; it is never reduced.`);
    }
  });

  it.each(SCALAR_KEYS)('%s = r (a valid Field, but not below r)', (key) => {
    const e = refusal(() => read(oprfWireInputs({ [key]: hex(R) })));
    expect(e.code).toBe('INVALID_REQUEST');
    expect(e.message).toBe(`${key} is not below the subgroup order r; it is never reduced.`);
  });

  it('oprf_beta = 0', () => {
    const e = refusal(() => read(oprfWireInputs({ oprf_beta: hex(0n) })));
    expect(e).toMatchObject({ code: 'INVALID_REQUEST', message: 'oprf_beta must not be zero.' });
  });

  it('a body that is null, a string or an array', () => {
    for (const body of [null, undefined, 'x', [], 7]) {
      expect(refusal(() => read(body)).code).toBe('INVALID_REQUEST');
    }
  });
});

describe('readOprfInputs pins the key hash', () => {
  it('refuses the pinned hash off by one in its last digit', () => {
    const k = NETWORK.keyHash;
    const last = k.slice(-1) === '0' ? '1' : '0';
    const e = refusal(() => read(oprfWireInputs({ oprf_key_hash: k.slice(0, -1) + last })));
    expect(e.code).toBe('OPRF_KEY_HASH_MISMATCH');
    expect(e.message).toContain(k);
  });

  it('refuses another well-formed Field (the circuits\' own fixture key)', () => {
    const fixtureKey = '0x2c1e40e54dd6ea3737951c5fc3517b8d0250c7675a70395421911f5bbcdc2604';
    expect(refusal(() => read(oprfWireInputs({ oprf_key_hash: fixtureKey }))).code).toBe('OPRF_KEY_HASH_MISMATCH');
  });

  it('refuses production by name before reading any value (even a malformed body)', () => {
    const e = refusal(() => read({ oprf_key_hash: 'garbage' }, 'production'));
    expect(e.code).toBe('OPRF_UNAVAILABLE');
    expect(e.message).toBe("No OPRF key is registered for the 'production' environment, so no wallet credential proof can be verified there yet.");
  });

  it('refuses an unset OPRF_ENVIRONMENT naming the variable', () => {
    const e = refusal(() => readOprfInputs(undefined, 'coinbase_attestation', oprfWireInputs()));
    expect(e.code).toBe('OPRF_NOT_CONFIGURED');
    expect(e.message).toMatch(/OPRF_ENVIRONMENT is not set/);
  });

  it.each([
    ['an unknown circuit', 'coinbase_kyc', /Unknown circuit 'coinbase_kyc'/],
    ['OIDC', 'oidc_domain_attestation', /has no OPRF nullifier/],
  ])('refuses %s', (_n, circuit, msg) => {
    const e = refusal(() => read(oprfWireInputs(), 'staging', circuit));
    expect(e.code).toBe('OPRF_UNAVAILABLE');
    expect(e.message).toMatch(msg);
  });
});

describe('formatOprfInputs', () => {
  it('emits exactly the circuit main() names with the values untouched', () => {
    const out = formatOprfInputs(oprfParams());
    expect(Object.keys(out).sort()).toEqual([
      'domain', 'nullifier', 'oprf_beta', 'oprf_dlog_e', 'oprf_dlog_s', 'oprf_key_hash',
      'oprf_public_key_x', 'oprf_public_key_y', 'oprf_response_x', 'oprf_response_y', 'scope',
    ]);
    expect(out).toEqual(oprfParams());
  });

  it('throws without the OPRF inputs or with one missing', () => {
    expect(() => formatOprfInputs(undefined)).toThrow(/OPRF nullifier inputs are missing/);
    const { scope: _s, ...rest } = oprfParams();
    expect(() => formatOprfInputs(rest as never)).toThrow(/OPRF input scope/);
  });
});
