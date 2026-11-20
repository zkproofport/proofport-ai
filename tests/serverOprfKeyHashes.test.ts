/**
 * The server's mirror of core's OPRF key-hash table, and OPRF_ENVIRONMENT.
 *
 *   rows        staging/local = the test network's key hash recorded in
 *               oprf-vectors.json `network` (byte-identical to core's copy),
 *               for every OPRF circuit; production has NO row
 *   errors      unknown env / production / unknown circuit / circuit without
 *               an OPRF nullifier each named, never another row
 *   env var     unset -> undefined (requests refused later), known names
 *               accepted, '' / 'prod' / 'Staging' / ' staging' refused at startup
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { ALL_CIRCUIT_IDS } from '../src/config/circuitIds.js';
import {
  OPRF_CIRCUIT_IDS,
  OPRF_ENVIRONMENTS,
  OPRF_KEY_HASHES,
  TACEO_TESTNET_OPRF_KEY_HASH,
  getPinnedOprfKeyHash,
  parseOprfEnvironment,
} from '../src/config/oprfKeyHashes.js';

const vectors = createRequire(import.meta.url)('./fixtures/oprf-vectors.json') as { network: { keyHash: string } };
const KNOWN = ALL_CIRCUIT_IDS as readonly string[];

describe('OPRF key-hash rows (mirror of core)', () => {
  it('the testnet hash is the one the recorded network answer carries', () => {
    expect(TACEO_TESTNET_OPRF_KEY_HASH).toBe(vectors.network.keyHash);
  });

  it.each(['staging', 'local'] as const)('%s pins the test network key for every OPRF circuit', (env) => {
    for (const id of OPRF_CIRCUIT_IDS) {
      expect(getPinnedOprfKeyHash(env, id, KNOWN)).toBe(vectors.network.keyHash);
    }
    expect(Object.keys(OPRF_KEY_HASHES[env]!).sort()).toEqual([...OPRF_CIRCUIT_IDS].sort());
  });

  it('every OPRF circuit id is a canonical id', () => {
    for (const id of OPRF_CIRCUIT_IDS) expect(KNOWN).toContain(id);
  });

  it('production has no row and is refused by name, never given the test key', () => {
    expect(OPRF_KEY_HASHES.production).toBeNull();
    for (const id of OPRF_CIRCUIT_IDS) {
      expect(() => getPinnedOprfKeyHash('production', id, KNOWN)).toThrow(
        "No OPRF key is registered for the 'production' environment, so no wallet credential proof can be verified there yet.",
      );
    }
  });

  it.each([undefined, null, '', 'prod', 'Staging', 'staging ', 'mainnet', 0])('refuses environment %j by name', (env) => {
    expect(() => getPinnedOprfKeyHash(env, 'coinbase_attestation', KNOWN)).toThrow(/Unknown OPRF environment .* Known: production, staging, local\./);
  });

  it.each(['coinbase_kyc', 'nonexistent', '', 'COINBASE_ATTESTATION', undefined, 7])('refuses unknown circuit %j by name', (id) => {
    expect(() => getPinnedOprfKeyHash('staging', id, KNOWN)).toThrow(/Unknown circuit/);
  });

  it('refuses a canonical circuit without an OPRF nullifier (OIDC)', () => {
    expect(() => getPinnedOprfKeyHash('staging', 'oidc_domain_attestation', KNOWN)).toThrow(/oidc_domain_attestation has no OPRF nullifier/);
  });

  it('every canonical id is either an OPRF circuit or refused as having none -- no third outcome', () => {
    for (const id of KNOWN) {
      if ((OPRF_CIRCUIT_IDS as readonly string[]).includes(id)) {
        expect(getPinnedOprfKeyHash('local', id, KNOWN)).toMatch(/^0x[0-9a-f]{64}$/);
      } else {
        expect(() => getPinnedOprfKeyHash('local', id, KNOWN)).toThrow(/has no OPRF nullifier/);
      }
    }
  });
});

describe('OPRF_ENVIRONMENT', () => {
  it('unset is undefined: the server starts and refuses wallet proofs later', () => {
    expect(parseOprfEnvironment(undefined)).toBeUndefined();
  });

  it.each([...OPRF_ENVIRONMENTS])('accepts %s', (env) => {
    expect(parseOprfEnvironment(env)).toBe(env);
  });

  it.each(['', ' ', 'prod', 'Staging', 'LOCAL', 'staging\n', 'testnet', 'production,staging'])('refuses %j at startup, naming the known values', (v) => {
    expect(() => parseOprfEnvironment(v)).toThrow(/OPRF_ENVIRONMENT must be one of: production, staging, local/);
  });
});
