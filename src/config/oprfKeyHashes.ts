/**
 * The OPRF key hash a wallet credential proof must carry, per environment and
 * proof type, and the server's OPRF environment.
 *
 * MIRROR of core's `oprfKeyHashes.ts` + `oprfKeys.ts`
 * (proofport-app-sdk packages/core/src/). The published core this repository
 * pins (0.4.0-beta.8) does not ship them; once a core release after
 * 0.4.0-beta.8 does, delete this file and import `OPRF_KEY_HASHES` /
 * `getPinnedOprfKeyHash` from core. Until then
 * tests/serverOprfKeyHashes.test.ts holds the rows to
 * tests/fixtures/oprf-vectors.json (byte-identical to core's copy) and the
 * error semantics to core's.
 *
 * Why a key hash is pinned: the circuit accepts an OPRF answer from ANY key
 * consistent with itself. A proof under another key proves nothing about the
 * nullifier, so the verifier compares the proof's `oprf_key_hash` with the
 * row below. This server compares it BEFORE payment, so a proof every
 * verifier would refuse is never charged for.
 *
 * Rows:
 * - staging and local: the public test network's key (one key for every
 *   proof type). Hash = Poseidon2_t3(DS_key, D.x, D.y)[1] of
 *     x 0x162fc76f99b6baa49ae260bbfac6c3a5657738bdd46f387dfa820beee7ab789e
 *     y 0x0f3d63eee4a861343e2397cfe40f21dbd95a4c780bc538c82ececa1e1549558e
 *   (oprf-vectors.json `oracles.network`, recorded 2026-11-18).
 * - production: no row. No production OPRF network has issued a key for
 *   this integration, so every wallet credential request is refused there,
 *   by name. Never the test key.
 */

/** Where proofs are made and verified for. Same names as core's. */
export type OprfEnvironment = 'production' | 'staging' | 'local';

export const OPRF_ENVIRONMENTS: readonly OprfEnvironment[] = Object.freeze(['production', 'staging', 'local'] as const);

/** The circuits whose public inputs carry the OPRF nullifier (core's OPRF_CIRCUIT_IDS). */
export const OPRF_CIRCUIT_IDS = Object.freeze([
  'coinbase_attestation',
  'coinbase_country_attestation',
  'giwa_attestation',
  'dojang_playground',
  'human_passport_score',
] as const);
export type OprfCircuitId = (typeof OPRF_CIRCUIT_IDS)[number];

/** Poseidon2_t3(DS_key, D.x, D.y)[1] of the public test network key (above). */
export const TACEO_TESTNET_OPRF_KEY_HASH = '0x039ecd4ea1875bb5c7f7a1bfae692cab271e3f3f25df4e5ab691fcb17586e6d1';

const testnet = (): Readonly<Record<OprfCircuitId, string>> =>
  Object.freeze({
    coinbase_attestation: TACEO_TESTNET_OPRF_KEY_HASH,
    coinbase_country_attestation: TACEO_TESTNET_OPRF_KEY_HASH,
    giwa_attestation: TACEO_TESTNET_OPRF_KEY_HASH,
    dojang_playground: TACEO_TESTNET_OPRF_KEY_HASH,
    human_passport_score: TACEO_TESTNET_OPRF_KEY_HASH,
  } satisfies Record<OprfCircuitId, string>);

/** environment -> proof type -> key hash; `null`: no key exists there. */
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
 *   nullifier. `knownCircuits` is every canonical id (core's ALL_CIRCUIT_IDS),
 *   passed in so this mirror stays free of imports.
 */
export function getPinnedOprfKeyHash(environment: unknown, circuit: unknown, knownCircuits: readonly string[]): string {
  if (!isOprfEnvironment(environment)) {
    throw new Error(`Unknown OPRF environment '${String(environment)}'. Known: ${OPRF_ENVIRONMENTS.join(', ')}.`);
  }
  const rows = OPRF_KEY_HASHES[environment];
  if (rows === null) {
    throw new Error(
      `No OPRF key is registered for the '${environment}' environment, so no wallet credential proof can be verified there yet.`,
    );
  }
  if (typeof circuit !== 'string' || !knownCircuits.includes(circuit)) {
    throw new Error(`Unknown circuit '${String(circuit)}'. Known: ${knownCircuits.join(', ')}.`);
  }
  if (!isOprfCircuitId(circuit)) {
    throw new Error(`${circuit} has no OPRF nullifier. Circuits that do: ${OPRF_CIRCUIT_IDS.join(', ')}.`);
  }
  const row = rows[circuit];
  if (row === undefined) {
    throw new Error(`No OPRF key hash for ${circuit} in '${environment}'.`);
  }
  return row;
}

/**
 * The server's OPRF environment from `OPRF_ENVIRONMENT`.
 *
 * Unset -> `undefined`: the server starts, and every wallet credential prove
 * request is refused (before payment) naming the variable. No default, and
 * never derived from the chain RPC: a guessed environment pins the wrong key.
 * Set to anything but a known name (including '') -> throws at startup.
 */
export function parseOprfEnvironment(value: string | undefined): OprfEnvironment | undefined {
  if (value === undefined) return undefined;
  if (!isOprfEnvironment(value)) {
    throw new Error(`OPRF_ENVIRONMENT must be one of: ${OPRF_ENVIRONMENTS.join(', ')} (got: ${JSON.stringify(value)})`);
  }
  return value;
}
