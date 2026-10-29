/**
 * proofport-ai's circuit identifiers vs `@zkproofport-app/core/circuits`.
 *
 * Core owns the canonical circuit identifiers, and both trees in this repo now
 * import them from it:
 *
 *   - `src/config/circuitIds.ts`         -- the server tree
 *   - `packages/sdk/src/circuits.ts`     -- the published @zkproofport-ai/sdk
 *
 * What each tree still owns is its list of PROVABLE circuits. The two trees
 * compile and ship separately (`rootDir: src` in each, different npm packages
 * and Docker images), so neither can import the other's list; this file holds
 * them equal, checks they are subsets of what core names (and never a circuit
 * core marks `planned`), and that every per-circuit registry is keyed by
 * canonical ids.
 */
import { describe, it, expect } from 'vitest';
import * as core from '@zkproofport-app/core/circuits';

import * as serverIds from '../src/config/circuitIds.js';
import * as sdkIds from '../packages/sdk/src/circuits.js';
import { CIRCUITS as SERVER_CIRCUITS } from '../src/config/circuits.js';
import { FALLBACK_VERIFIERS } from '../src/config/contracts.js';
import { CIRCUITS as SDK_CIRCUITS, attestationSource } from '../packages/sdk/src/constants.js';
import { computeCircuitParams } from '../src/input/inputBuilder.js';
import { CIRCUIT_NAME_MAP, CIRCUIT_ID_MAP } from '../packages/sdk/src/types.js';

describe('both trees take the canonical ids from core, not a copy', () => {
  it('re-exports core\'s own objects, so there is nothing to drift', () => {
    expect(serverIds.CIRCUIT_IDS).toBe(core.CIRCUIT_IDS);
    expect(sdkIds.CIRCUIT_IDS).toBe(core.CIRCUIT_IDS);
    expect(serverIds.ALL_CIRCUIT_IDS).toBe(core.ALL_CIRCUIT_IDS);
    expect(sdkIds.ALL_CIRCUIT_IDS).toBe(core.ALL_CIRCUIT_IDS);
    expect(serverIds.CIRCUIT_SUPPORT_STATUS).toBe(core.CIRCUIT_SUPPORT_STATUS);
    expect(sdkIds.CIRCUIT_SUPPORT_STATUS).toBe(core.CIRCUIT_SUPPORT_STATUS);
    expect(serverIds.isCanonicalCircuitId).toBe(core.isCircuitId);
    expect(sdkIds.isCanonicalCircuitId).toBe(core.isCircuitId);
  });

  it('keeps the two provable lists identical', () => {
    // The two trees ship separately and cannot import each other, so this is
    // the only thing stopping one being updated and the other forgotten.
    expect([...sdkIds.PROVABLE_CIRCUIT_IDS]).toEqual([...serverIds.PROVABLE_CIRCUIT_IDS]);
  });

  it('rejects hyphenated route names, which are not circuit ids', () => {
    for (const notAnId of ['coinbase-kyc', 'coinbase-country', 'oidc-domain', 'giwa-attestation']) {
      expect(serverIds.isCanonicalCircuitId(notAnId)).toBe(false);
      expect(sdkIds.isCanonicalCircuitId(notAnId)).toBe(false);
    }
  });
});

/**
 * The Korean mobile ID circuits were removed from every repository on
 * 2026-10-29 (core 0.4.0-beta.0). Their ids are now unknown everywhere: not
 * canonical, not provable, and a lookup by one throws naming the known ids
 * rather than resolving to another circuit.
 */
describe('the removed Korean mobile ID ids are unknown', () => {
  const REMOVED = ['mdl_kr_age', 'mdl_kr_region', 'mdl_kr_ownership'];

  it('core, the server and the SDK name none of them', () => {
    for (const id of REMOVED) {
      expect(core.ALL_CIRCUIT_IDS as readonly string[]).not.toContain(id);
      expect(Object.values(core.CIRCUIT_IDS) as string[]).not.toContain(id);
      expect(Object.keys(core.CIRCUIT_SUPPORT_STATUS)).not.toContain(id);
      expect(serverIds.isCanonicalCircuitId(id)).toBe(false);
      expect(sdkIds.isCanonicalCircuitId(id)).toBe(false);
      expect(serverIds.PROVABLE_CIRCUIT_IDS as readonly string[]).not.toContain(id);
      expect(sdkIds.PROVABLE_CIRCUIT_IDS as readonly string[]).not.toContain(id);
      expect(Object.keys(CIRCUIT_NAME_MAP)).not.toContain(id);
    }
  });

  it('the server input builder throws naming the known circuits', async () => {
    for (const id of REMOVED) {
      await expect(
        computeCircuitParams({ circuitId: id } as unknown as Parameters<typeof computeCircuitParams>[0], '', []),
      ).rejects.toThrow(new RegExp(`Unknown circuit: ${id}\\. Known: .*coinbase_attestation`));
    }
  });

  it('the SDK attestation lookup throws naming the known circuits', () => {
    for (const id of REMOVED) {
      expect(() => attestationSource(id as unknown as Parameters<typeof attestationSource>[0]))
        .toThrow(new RegExp(`Unknown circuit '${id}'\\. Known: .*coinbase_attestation`));
    }
  });
});

describe('what this server proves is a subset of what core names', () => {
  it('every provable circuit is a canonical id', () => {
    for (const id of serverIds.PROVABLE_CIRCUIT_IDS) {
      expect(core.ALL_CIRCUIT_IDS, `${id} is not a canonical circuit id`).toContain(id);
    }
  });

  // 'experimental' is allowed and 'planned' is not, which is the whole
  // distinction: an experimental circuit compiles, has a deployed verifier and
  // produces a proof that verifies -- on a testnet, with its layout still open.
  // A planned one has an identifier and nothing behind it, so selling a proof
  // for it would be selling something that cannot be made.
  it('never sells proofs for a circuit core still marks planned', () => {
    for (const id of serverIds.PROVABLE_CIRCUIT_IDS) {
      expect(
        ['supported', 'experimental'],
        `${id} is provable here but '${core.CIRCUIT_SUPPORT_STATUS[id]}' in core`,
      ).toContain(core.CIRCUIT_SUPPORT_STATUS[id]);
    }
  });

  it('has no provable circuit that is also unknown to the guards', () => {
    for (const id of serverIds.PROVABLE_CIRCUIT_IDS) {
      expect(serverIds.isProvableCircuitId(id)).toBe(true);
      expect(sdkIds.isProvableCircuitId(id)).toBe(true);
    }
    for (const planned of core.PLANNED_CIRCUIT_IDS) {
      expect(serverIds.isProvableCircuitId(planned)).toBe(false);
    }
  });
});

describe('every per-circuit registry is keyed by canonical ids', () => {
  /**
   * Each entry is a structure that carries per-circuit knowledge this repo owns
   * (layouts, artifact paths, verifier addresses). The knowledge stays here; the
   * keys must be canonical. Anything keyed by a typo would fail lookups
   * silently at request time.
   */
  const registries: Array<[string, readonly string[]]> = [
    ['src/config/circuits.ts CIRCUITS', Object.keys(SERVER_CIRCUITS)],
    ['packages/sdk/src/constants.ts CIRCUITS', Object.keys(SDK_CIRCUITS)],
    ['packages/sdk/src/types.ts CIRCUIT_ID_MAP', Object.keys(CIRCUIT_ID_MAP)],
    ['packages/sdk/src/types.ts CIRCUIT_NAME_MAP values', Object.values(CIRCUIT_NAME_MAP)],
    ...Object.entries(FALLBACK_VERIFIERS).map(
      ([chainId, verifiers]) =>
        [`src/config/contracts.ts FALLBACK_VERIFIERS['${chainId}']`, Object.keys(verifiers)] as [
          string,
          readonly string[],
        ],
    ),
  ];

  it.each(registries)('%s uses only canonical ids', (_label, keys) => {
    for (const key of keys) {
      expect(core.ALL_CIRCUIT_IDS).toContain(key);
    }
  });

  it.each(registries)('%s covers every provable circuit', (_label, keys) => {
    for (const id of serverIds.PROVABLE_CIRCUIT_IDS) {
      expect(keys).toContain(id);
    }
  });
});

describe('CIRCUITS registries agree with their own keys', () => {
  it('src/config/circuits.ts stores each id under its own key', () => {
    for (const [key, circuit] of Object.entries(SERVER_CIRCUITS)) {
      expect(circuit.id).toBe(key);
    }
  });
});
