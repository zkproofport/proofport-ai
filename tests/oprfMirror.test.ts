/**
 * The OPRF client the SDK imports from @zkproofport-app/core (installed from
 * the registry), the key-hash table it reads through packages/sdk/src/oprf/
 * keyHashes.ts, the network table, and the two arithmetic files still
 * mirrored from core (packages/sdk/src/oprf/core, scripts/sync-oprf-mirror.mjs),
 * held to the shared vectors (tests/fixtures/oprf-vectors.json, byte-identical
 * to core's). Every oracle in that file is independent of this code: the
 * circuits' Rust fixture tool, proofport-oprf's Rust node side, ethers, and
 * one real answer from the public test network.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  blindOprfQuery,
  finalizeOprf,
  oprfKeyHash,
  oprfNameError,
  oprfNullifier,
  oprfQuery,
  oprfRequestDigest,
  reduceOprfName,
  unblindOprfResponse,
  verifyOprfDlogEquality,
} from '@zkproofport-app/core/oprf';
import {
  TACEO_TESTNET_OPRF_KEY_HASH as TESTNET_OPRF_KEY_HASH,
  TACEO_TESTNET_OPRF_PUBLIC_KEY as TESTNET_OPRF_PUBLIC_KEY,
} from '@zkproofport-app/core';
import { OPRF_CIRCUIT_IDS, OPRF_KEY_HASHES, getPinnedOprfKeyHash } from '../packages/sdk/src/oprf/keyHashes.js';
import { OPRF_NETWORKS, getOprfNetwork } from '../packages/sdk/src/oprf/networks.js';

const V = createRequire(import.meta.url)('./fixtures/oprf-vectors.json');
const ROOT = join(import.meta.dirname, '..');
const SIBLING_CORE = join(ROOT, '..', 'proofport-app-sdk', 'packages', 'core', 'src', 'oprf');

describe('core\'s OPRF client agrees with the shared vectors', () => {
  it.each(V.names.map((n: { name: string; verdict: string | null; reduced: string | null; note?: string }) => [n.note ?? n.name, n]))(
    'name rule and reduction: %s',
    (_label, n: { name: string; verdict: string | null; reduced: string | null }) => {
      expect(oprfNameError(n.name)).toBe(n.verdict);
      if (n.verdict === null) expect(reduceOprfName(n.name)).toBe(n.reduced);
      else expect(() => reduceOprfName(n.name)).toThrow();
    },
  );

  it.each(V.jsOnlyNames.map((n: { name: string; verdict: string; note?: string }) => [n.note ?? n.name, n]))(
    'JS-only name (lone surrogate etc.): %s',
    (_label, n: { name: string; verdict: string }) => {
      expect(oprfNameError(n.name)).toBe(n.verdict);
    },
  );

  it.each(V.digests.map((d: { domainName: string; scopeName: string; deadline: number; digest: string }) => [d.domainName, d]))(
    'EIP-712 OprfRequest digest for %s equals the vector and ethers',
    (_label, d: { domainName: string; scopeName: string; deadline: number; digest: string }) => {
      expect(oprfRequestDigest(d.domainName, d.scopeName, d.deadline)).toBe(d.digest);
      const viaEthers = ethers.TypedDataEncoder.hash(
        { name: 'TACEO:OPRF', version: '1' },
        { OprfRequest: [
          { name: 'statement', type: 'string' }, { name: 'domainName', type: 'string' },
          { name: 'scopeName', type: 'string' }, { name: 'deadline', type: 'uint256' },
        ] },
        { statement: 'TACEO:OPRF Request', domainName: d.domainName, scopeName: d.scopeName, deadline: d.deadline },
      );
      expect(viaEthers).toBe(d.digest);
    },
  );

  it.each(V.evaluations.map((e: { note: string }) => [e.note, e]))('evaluation: %s', (_label, e: any) => {
    const q = oprfQuery({ address: e.address, domain: e.domain, scope: e.scope });
    expect(q).toBe(e.query);
    expect(oprfKeyHash(e.publicKey)).toBe(e.keyHash);
    expect(blindOprfQuery(q, e.beta)).toEqual(e.blindedQuery);
    expect(verifyOprfDlogEquality({ publicKey: e.publicKey, blindedQuery: e.blindedQuery, blindedResponse: e.blindedResponse, e: e.dlogE, s: e.dlogS })).toBe(true);
    expect(unblindOprfResponse(e.blindedResponse, e.beta)).toEqual(e.response);
    expect(oprfNullifier(q, e.response)).toBe(e.nullifier);
  });

  it('the recorded test network answer finalizes under the pinned staging key hash', () => {
    const n = V.network;
    const address = '0x' + BigInt(n.addressField).toString(16).padStart(40, '0');
    const out = finalizeOprf({
      address, domain: n.domain, scope: n.scope, beta: n.beta, publicKey: n.publicKey,
      blindedResponse: n.blindedResponse, dlogE: n.dlogE, dlogS: n.dlogS,
      expectedKeyHash: getPinnedOprfKeyHash('staging', 'coinbase_attestation'),
    });
    expect(out.nullifier).toBe(n.nullifier);
    expect(out.oprf_key_hash).toBe(n.keyHash);
    expect(reduceOprfName(n.domainName)).toBe(n.domain);
    expect(reduceOprfName(n.scopeName)).toBe(n.scope);
  });

  it.skipIf(!existsSync(SIBLING_CORE))(
    'the two mirrored arithmetic files equal core\'s source (scripts/sync-oprf-mirror.mjs --check; needs the monorepo checkout)',
    () => {
      expect(() => execFileSync('node', [join(ROOT, 'scripts/sync-oprf-mirror.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' })).not.toThrow();
    },
  );
});

describe('pinned OPRF key hash table (core OPRF_KEY_HASHES, through the SDK module)', () => {
  const network = V.network;

  it('the test network hash is Poseidon2 of the test network key, and equals the recorded answer\'s', () => {
    expect(oprfKeyHash(TESTNET_OPRF_PUBLIC_KEY)).toBe(TESTNET_OPRF_KEY_HASH);
    expect(network.keyHash).toBe(TESTNET_OPRF_KEY_HASH);
    expect(network.publicKey).toEqual(TESTNET_OPRF_PUBLIC_KEY);
  });

  it.each(['staging', 'local'])('%s pins the test network hash for every OPRF circuit', env => {
    for (const c of OPRF_CIRCUIT_IDS) expect(getPinnedOprfKeyHash(env, c)).toBe(TESTNET_OPRF_KEY_HASH);
  });

  it('production has no row and is refused by name for every circuit, never given the test key', () => {
    expect(OPRF_KEY_HASHES.production).toBeNull();
    for (const c of OPRF_CIRCUIT_IDS) {
      expect(() => getPinnedOprfKeyHash('production', c)).toThrow(/No OPRF key is registered for the 'production' environment/);
    }
  });

  it.each([['prod'], ['Staging'], [''], [' staging'], [null], [undefined], [1]])('unknown environment %j is refused naming the known ones', env => {
    expect(() => getPinnedOprfKeyHash(env, 'coinbase_attestation')).toThrow(/Unknown OPRF environment .*Known: production, staging, local/);
  });

  it.each([['coinbase_kyc'], ['nope'], [''], [null]])('unknown circuit %j is refused naming it', c => {
    expect(() => getPinnedOprfKeyHash('staging', c)).toThrow(/Unknown circuit/);
  });

  it('OIDC has no OPRF nullifier', () => {
    expect(() => getPinnedOprfKeyHash('staging', 'oidc_domain_attestation')).toThrow(/has no OPRF nullifier/);
  });

  it('OPRF circuit list equals core\'s five wallet credential circuits', () => {
    expect([...OPRF_CIRCUIT_IDS].sort()).toEqual(
      ['coinbase_attestation', 'coinbase_country_attestation', 'dojang_playground', 'giwa_attestation', 'human_passport_score'],
    );
  });
});

describe('OPRF network table', () => {
  it('staging and local use the three-node test network, threshold 2, API-key module', () => {
    for (const env of ['staging', 'local']) {
      const n = getOprfNetwork(env);
      expect(n.nodes).toHaveLength(3);
      expect(n.threshold).toBe(2);
      expect(n.auth.kind).toBe('api-key');
      for (const u of n.nodes) expect(u).toMatch(/^https:\/\/node[012]\./);
    }
  });

  it('production has no network and is refused by name', () => {
    expect(OPRF_NETWORKS.production).toBeNull();
    expect(() => getOprfNetwork('production')).toThrow(/No OPRF network is registered for the 'production' environment/);
  });

  it.each([['prod'], [''], [undefined]])('unknown environment %j is refused', env => {
    expect(() => getOprfNetwork(env)).toThrow(/Unknown OPRF environment/);
  });
});
