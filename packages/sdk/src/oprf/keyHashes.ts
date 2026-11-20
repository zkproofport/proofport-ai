/**
 * The OPRF key hash a wallet credential proof must carry, per environment and
 * proof type.
 *
 * MIRROR of `OPRF_KEY_HASHES` / `getPinnedOprfKeyHash` in
 * `@zkproofport-app/core` (proofport-app-sdk packages/core/src/oprfKeyHashes.ts
 * and oprfKeys.ts). The published core this repository pins (0.4.0-beta.8)
 * does not ship them; once a later core release does, delete this file and
 * import them from core. tests/oprfClient.test.ts holds the hash below to the
 * shared vectors (tests/fixtures/oprf-vectors.json `oracles.network`), which
 * recompute it from the test network's public key.
 *
 * Why it is pinned: a circuit accepts an answer under ANY OPRF key that is
 * consistent with itself; whoever holds that key can compute every address's
 * nullifier under it. So the client refuses an answer under any other key
 * before a proof is generated, and the verifier refuses such a proof.
 *
 * - staging, local: the public test network's key (one key for every proof
 *   type), recorded 2026-11-17 and 2026-11-18 (circuits-dev.md, core's vectors).
 * - production: no row. No production OPRF key exists for this integration
 *   yet, so a production wallet proof is refused by name, never given the
 *   test key.
 */
import { ALL_CIRCUIT_IDS, CIRCUIT_IDS, type CanonicalCircuitId } from '../circuits.js';

export type OprfEnvironment = 'production' | 'staging' | 'local';

export const OPRF_ENVIRONMENTS: readonly OprfEnvironment[] = Object.freeze(['production', 'staging', 'local'] as const);

/** The wallet credential circuits that carry an OPRF nullifier (core's OPRF_CIRCUIT_IDS). */
export const OPRF_CIRCUIT_IDS = Object.freeze([
  CIRCUIT_IDS.COINBASE_ATTESTATION,
  CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
  CIRCUIT_IDS.GIWA_ATTESTATION,
  CIRCUIT_IDS.DOJANG_PLAYGROUND,
  CIRCUIT_IDS.HUMAN_PASSPORT_SCORE,
] as const satisfies readonly CanonicalCircuitId[]);

export type OprfCircuitId = (typeof OPRF_CIRCUIT_IDS)[number];

/** Poseidon2_t3(DS_key, D.x, D.y)[1] of the public test network's key. */
export const TESTNET_OPRF_KEY_HASH = '0x039ecd4ea1875bb5c7f7a1bfae692cab271e3f3f25df4e5ab691fcb17586e6d1';

/** That key, as the nodes return it with every answer. */
export const TESTNET_OPRF_PUBLIC_KEY = Object.freeze({
  x: '0x162fc76f99b6baa49ae260bbfac6c3a5657738bdd46f387dfa820beee7ab789e',
  y: '0x0f3d63eee4a861343e2397cfe40f21dbd95a4c780bc538c82ececa1e1549558e',
});

const testnet = (): Readonly<Record<OprfCircuitId, string>> =>
  Object.freeze({
    coinbase_attestation: TESTNET_OPRF_KEY_HASH,
    coinbase_country_attestation: TESTNET_OPRF_KEY_HASH,
    giwa_attestation: TESTNET_OPRF_KEY_HASH,
    dojang_playground: TESTNET_OPRF_KEY_HASH,
    human_passport_score: TESTNET_OPRF_KEY_HASH,
  } satisfies Record<OprfCircuitId, string>);

export const OPRF_KEY_HASHES: Readonly<Record<OprfEnvironment, Readonly<Record<OprfCircuitId, string>> | null>> = Object.freeze({
  production: null,
  staging: testnet(),
  local: testnet(),
});

export function isOprfEnvironment(value: unknown): value is OprfEnvironment {
  return typeof value === 'string' && (OPRF_ENVIRONMENTS as readonly string[]).includes(value);
}

export function isOprfCircuitId(value: unknown): value is OprfCircuitId {
  return typeof value === 'string' && (OPRF_CIRCUIT_IDS as readonly string[]).includes(value);
}

/**
 * The key hash a `circuit` proof must carry in `environment`.
 *
 * @throws Error naming the unknown environment, an environment with no OPRF
 *   key (production today), an unknown circuit, or a circuit with no OPRF
 *   nullifier. Never another row.
 */
export function getPinnedOprfKeyHash(environment: unknown, circuit: unknown): string {
  if (!isOprfEnvironment(environment)) {
    throw new Error(`Unknown OPRF environment '${String(environment)}'. Known: ${OPRF_ENVIRONMENTS.join(', ')}.`);
  }
  const rows = OPRF_KEY_HASHES[environment];
  if (rows === null) {
    throw new Error(
      `No OPRF key is registered for the '${environment}' environment, so no wallet credential proof can be verified there yet.`,
    );
  }
  if (typeof circuit !== 'string' || !(ALL_CIRCUIT_IDS as readonly string[]).includes(circuit)) {
    throw new Error(`Unknown circuit '${String(circuit)}'. Known: ${ALL_CIRCUIT_IDS.join(', ')}.`);
  }
  if (!isOprfCircuitId(circuit)) {
    throw new Error(`${circuit} has no OPRF nullifier. Circuits that do: ${OPRF_CIRCUIT_IDS.join(', ')}.`);
  }
  const row = rows[circuit];
  if (row === undefined) throw new Error(`No OPRF key hash for ${circuit} in '${environment}'.`);
  return row;
}
