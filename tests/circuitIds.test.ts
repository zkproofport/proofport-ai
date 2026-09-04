/**
 * Drift guard: proofport-ai's circuit identifiers vs the customer SDK's.
 *
 * `@zkproofport-app/sdk/circuits` owns the canonical circuit identifiers. This
 * repo cannot import that module yet (the published SDK does not export it —
 * see `src/config/circuitIds.ts` for the details), so it keeps two mirrors:
 *
 *   - `src/config/circuitIds.ts`         — the server tree
 *   - `packages/sdk/src/circuits.ts`     — the published @zkproofport-ai/sdk
 *
 * The two trees compile and ship separately (`rootDir: src` in each, different
 * npm packages and Docker images), so neither can import the other. This file
 * is what keeps them honest: it loads the REAL customer SDK and fails when
 * either mirror disagrees with it, or with the other.
 *
 * ## It fails rather than skips when it cannot find the SDK
 *
 * A guard that silently skips is worse than no guard, because the suite stays
 * green while the thing it guards rots. If neither the installed package nor
 * the sibling checkout is present, every test here fails with instructions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

import * as serverIds from '../src/config/circuitIds.js';
import * as sdkIds from '../packages/sdk/src/circuits.js';
import { CIRCUITS as SERVER_CIRCUITS } from '../src/config/circuits.js';
import { FALLBACK_VERIFIERS } from '../src/config/contracts.js';
import { CIRCUITS as SDK_CIRCUITS } from '../packages/sdk/src/constants.js';
import { CIRCUIT_NAME_MAP, CIRCUIT_ID_MAP } from '../packages/sdk/src/types.js';

/** The subset of `@zkproofport-app/sdk/circuits` this guard compares against. */
interface CustomerSdkCircuits {
  CIRCUIT_IDS: Record<string, string>;
  CIRCUIT_SUPPORT_STATUS: Record<string, string>;
  ALL_CIRCUIT_IDS: readonly string[];
  SUPPORTED_CIRCUIT_IDS: readonly string[];
  PLANNED_CIRCUIT_IDS: readonly string[];
}

/**
 * Candidate locations for the canonical module, most authoritative first.
 *
 * 1. The installed npm package — what production actually resolves once the
 *    SDK ships `./circuits`.
 * 2. The sibling checkout's build output, for the monorepo working tree today.
 *    `dist/circuits.mjs` is a dependency-free ESM bundle of `src/circuits.ts`,
 *    so plain `import()` can load it with no vite/TS transform involved.
 */
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SIBLING_SDK_DIR = path.resolve(THIS_DIR, '../../proofport-app-sdk');
const SIBLING_DIST_CANDIDATES = ['dist/circuits.mjs', 'dist/circuits.esm.js', 'dist/circuits.js'];

let customer: CustomerSdkCircuits;
let customerSource: string;

async function loadCustomerSdkCircuits(): Promise<{ mod: CustomerSdkCircuits; source: string }> {
  const attempts: string[] = [];

  try {
    const mod = (await import('@zkproofport-app/sdk/circuits')) as unknown as CustomerSdkCircuits;
    return { mod, source: 'installed package @zkproofport-app/sdk/circuits' };
  } catch (err) {
    attempts.push(`  - @zkproofport-app/sdk/circuits: ${(err as Error).message}`);
  }

  for (const rel of SIBLING_DIST_CANDIDATES) {
    const abs = path.join(SIBLING_SDK_DIR, rel);
    if (!fs.existsSync(abs)) {
      attempts.push(`  - ${abs}: not built`);
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(abs).href)) as unknown as CustomerSdkCircuits;
      // A CJS bundle loaded through import() arrives under `default`.
      const resolved = (mod.CIRCUIT_IDS ? mod : (mod as any).default) as CustomerSdkCircuits;
      return { mod: resolved, source: abs };
    } catch (err) {
      attempts.push(`  - ${abs}: ${(err as Error).message}`);
    }
  }

  throw new Error(
    'Cannot locate the canonical circuit identifiers in @zkproofport-app/sdk.\n' +
      'This guard fails instead of skipping: without the SDK there is nothing to ' +
      'check the mirrors against, and a green run would mean nothing.\n\n' +
      'Fix by either:\n' +
      '  a) installing a published SDK that exports the subpath:\n' +
      '       npm install @zkproofport-app/sdk@<version exporting ./circuits>\n' +
      `  b) building the sibling checkout:\n` +
      `       npm --prefix ${SIBLING_SDK_DIR} run build\n\n` +
      'Tried:\n' +
      attempts.join('\n'),
  );
}

beforeAll(async () => {
  const loaded = await loadCustomerSdkCircuits();
  customer = loaded.mod;
  customerSource = loaded.source;
  expect(customerSource, 'canonical source must be identified').toBeTruthy();
});

describe('circuit identifiers match the customer SDK', () => {
  it('exposes the same canonical ids, in the same order', () => {
    expect(serverIds.ALL_CIRCUIT_IDS).toEqual(customer.ALL_CIRCUIT_IDS);
    expect(sdkIds.ALL_CIRCUIT_IDS).toEqual(customer.ALL_CIRCUIT_IDS);
  });

  it('exposes the same constant-name to id mapping', () => {
    // Compares keys AND values, so a renamed constant is caught as well as a
    // renamed id.
    expect({ ...serverIds.CIRCUIT_IDS }).toEqual({ ...customer.CIRCUIT_IDS });
    expect({ ...sdkIds.CIRCUIT_IDS }).toEqual({ ...customer.CIRCUIT_IDS });
  });

  it('agrees on which circuits are supported and which are planned', () => {
    expect({ ...serverIds.CIRCUIT_SUPPORT_STATUS }).toEqual({ ...customer.CIRCUIT_SUPPORT_STATUS });
    expect({ ...sdkIds.CIRCUIT_SUPPORT_STATUS }).toEqual({ ...customer.CIRCUIT_SUPPORT_STATUS });

    expect(serverIds.SUPPORTED_CIRCUIT_IDS).toEqual(customer.SUPPORTED_CIRCUIT_IDS);
    expect(sdkIds.SUPPORTED_CIRCUIT_IDS).toEqual(customer.SUPPORTED_CIRCUIT_IDS);
    expect(serverIds.PLANNED_CIRCUIT_IDS).toEqual(customer.PLANNED_CIRCUIT_IDS);
    expect(sdkIds.PLANNED_CIRCUIT_IDS).toEqual(customer.PLANNED_CIRCUIT_IDS);
  });

  it('keeps the two in-repo mirrors byte-identical in the parts that matter', () => {
    // The two trees ship separately and cannot import each other, so this is
    // the only thing stopping one being updated and the other forgotten.
    expect({ ...sdkIds.CIRCUIT_IDS }).toEqual({ ...serverIds.CIRCUIT_IDS });
    expect({ ...sdkIds.CIRCUIT_SUPPORT_STATUS }).toEqual({ ...serverIds.CIRCUIT_SUPPORT_STATUS });
    expect([...sdkIds.PROVABLE_CIRCUIT_IDS]).toEqual([...serverIds.PROVABLE_CIRCUIT_IDS]);
  });

  it('rejects hyphenated route names, which are not circuit ids', () => {
    for (const notAnId of ['coinbase-kyc', 'coinbase-country', 'oidc-domain', 'mdl-kr-age']) {
      expect(serverIds.isCanonicalCircuitId(notAnId)).toBe(false);
      expect(sdkIds.isCanonicalCircuitId(notAnId)).toBe(false);
    }
  });
});

describe('what this server proves is a subset of what the SDK names', () => {
  it('every provable circuit is a canonical id', () => {
    for (const id of serverIds.PROVABLE_CIRCUIT_IDS) {
      expect(customer.ALL_CIRCUIT_IDS, `${id} is not a canonical circuit id`).toContain(id);
    }
  });

  it('never sells proofs for a circuit the SDK still marks planned', () => {
    for (const id of serverIds.PROVABLE_CIRCUIT_IDS) {
      expect(
        customer.CIRCUIT_SUPPORT_STATUS[id],
        `${id} is provable here but '${customer.CIRCUIT_SUPPORT_STATUS[id]}' in the SDK`,
      ).toBe('supported');
    }
  });

  it('has no provable circuit that is also unknown to the guards', () => {
    for (const id of serverIds.PROVABLE_CIRCUIT_IDS) {
      expect(serverIds.isProvableCircuitId(id)).toBe(true);
      expect(sdkIds.isProvableCircuitId(id)).toBe(true);
    }
    for (const planned of customer.PLANNED_CIRCUIT_IDS) {
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
      expect(customer.ALL_CIRCUIT_IDS).toContain(key);
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
