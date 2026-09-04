/**
 * Canonical ZKProofport circuit identifiers, for the proofport-ai server.
 *
 * ## The customer SDK owns this list
 *
 * `@zkproofport-app/sdk/circuits` (repo `zkproofport/proofport-app-sdk`,
 * `src/circuits.ts`) is the single source of truth for circuit identifiers
 * across every layer: the mobile app, the relay, the demo, and this server.
 * The names below are that module's values, verbatim — the same seven ids in
 * the same order with the same support statuses.
 *
 * This file is a **mirror, not a second source of truth**. Nothing here may be
 * edited on its own judgement: change the SDK first, then bring the change over.
 *
 * ## Why a mirror instead of an import, today
 *
 * The intended shape is `export * from '@zkproofport-app/sdk/circuits'`, and the
 * mirror exists only because that import cannot resolve yet:
 *
 * 1. The newest published customer SDK (0.2.11) does not ship the module. Its
 *    `exports` map has a single `"."` entry and its tarball has no `circuits.*`
 *    in `dist/`, so both `@zkproofport-app/sdk/circuits` and the deep path
 *    `@zkproofport-app/sdk/dist/circuits.js` fail with
 *    `ERR_PACKAGE_PATH_NOT_EXPORTED`. Adding the dependency today breaks
 *    `npm run typecheck` here and `npx tsc -p packages/sdk` in
 *    `.github/workflows/npm-publish.yml`, which reinstalls from the registry.
 * 2. A `file:../proofport-app-sdk` link is not an option either: proofport-ai is
 *    its own git repo (a submodule), and its Docker build context and the npm
 *    tarballs for `@zkproofport-ai/sdk` / `@zkproofport-ai/mcp` cannot reach a
 *    sibling checkout.
 *
 * ## Switching over once the SDK publishes `./circuits`
 *
 * 1. `npm install @zkproofport-app/sdk@<version that exports ./circuits>`
 * 2. Replace the literals below with
 *    `export { CIRCUIT_IDS, CIRCUIT_SUPPORT_STATUS, ALL_CIRCUIT_IDS, ... }
 *     from '@zkproofport-app/sdk/circuits';`
 *    keeping the `PROVABLE_CIRCUIT_IDS` block, which is this repo's own.
 * 3. `tests/circuitIds.test.ts` then compares the SDK against itself and keeps
 *    passing.
 *
 * ## What stops the mirror drifting
 *
 * `tests/circuitIds.test.ts` reads the real customer SDK — the installed
 * package if present, otherwise the sibling checkout at `../proofport-app-sdk`
 * — and fails when this file disagrees with it. It fails, rather than skips,
 * when it can find neither.
 *
 * ## Identifiers are canonical and case-sensitive
 *
 * Each id is the circuit's `name` in its `Nargo.toml`, verbatim: lowercase with
 * underscores. Hyphenated spellings (`coinbase-kyc`) are directory or UI route
 * names elsewhere and are not circuit ids; passing one produces a nullifier
 * mismatch or a failed on-chain lookup rather than a clear error.
 */

/**
 * Whether a circuit is officially supported today or still on the roadmap.
 *
 * - `supported` — generally available.
 * - `planned` — the identifier is reserved, but availability, inputs and
 *   public-input layout may still change.
 */
export type CircuitSupportStatus = 'supported' | 'planned';

/**
 * Every canonical circuit identifier ZKProofport has assigned, keyed by a stable
 * constant name. Mirrors `CIRCUIT_IDS` in `@zkproofport-app/sdk/circuits`.
 *
 * This is the full ZKProofport catalogue, which is wider than what this server
 * can prove — see {@link PROVABLE_CIRCUIT_IDS} for that.
 */
export const CIRCUIT_IDS = Object.freeze({
  /** Coinbase KYC attestation. Officially supported. */
  COINBASE_ATTESTATION: 'coinbase_attestation',
  /** Coinbase country attestation (inclusion / exclusion). Officially supported. */
  COINBASE_COUNTRY_ATTESTATION: 'coinbase_country_attestation',
  /** OIDC email-domain attestation. Officially supported. */
  OIDC_DOMAIN_ATTESTATION: 'oidc_domain_attestation',
  /** GIWA attestation. Planned — not officially supported yet. */
  GIWA_ATTESTATION: 'giwa_attestation',
  /** Korea Mobile ID ownership. Planned — not officially supported yet. */
  MDL_KR_OWNERSHIP: 'mdl_kr_ownership',
  /** Korea Mobile ID age threshold. Planned — not officially supported yet. */
  MDL_KR_AGE: 'mdl_kr_age',
  /** Korea Mobile ID si/do region. Planned — not officially supported yet. */
  MDL_KR_REGION: 'mdl_kr_region',
} as const);

/**
 * Union of every canonical circuit identifier.
 *
 * The customer SDK calls this type `CircuitId`. It is named
 * `CanonicalCircuitId` here because {@link CircuitId} in this repo has always
 * meant the narrower set proofport-ai can prove, and silently widening it would
 * let `circuit: 'mdl_kr_age'` typecheck against an endpoint that cannot serve it.
 */
export type CanonicalCircuitId = (typeof CIRCUIT_IDS)[keyof typeof CIRCUIT_IDS];

/**
 * Support status for every canonical circuit. Exhaustive over
 * {@link CanonicalCircuitId}, so an identifier without a status is a compile
 * error.
 */
export const CIRCUIT_SUPPORT_STATUS: Readonly<Record<CanonicalCircuitId, CircuitSupportStatus>> =
  Object.freeze({
    coinbase_attestation: 'supported',
    coinbase_country_attestation: 'supported',
    oidc_domain_attestation: 'supported',
    giwa_attestation: 'planned',
    mdl_kr_ownership: 'planned',
    mdl_kr_age: 'planned',
    mdl_kr_region: 'planned',
  } as const);

/** Every canonical circuit identifier, in declaration order. */
export const ALL_CIRCUIT_IDS: readonly CanonicalCircuitId[] = Object.freeze(
  Object.values(CIRCUIT_IDS) as CanonicalCircuitId[],
);

/** Circuits ZKProofport officially supports today. Derived, so it cannot desync. */
export const SUPPORTED_CIRCUIT_IDS: readonly CanonicalCircuitId[] = Object.freeze(
  ALL_CIRCUIT_IDS.filter((id) => CIRCUIT_SUPPORT_STATUS[id] === 'supported'),
);

/** Circuits whose identifiers are reserved but not officially supported yet. */
export const PLANNED_CIRCUIT_IDS: readonly CanonicalCircuitId[] = Object.freeze(
  ALL_CIRCUIT_IDS.filter((id) => CIRCUIT_SUPPORT_STATUS[id] === 'planned'),
);

/**
 * Narrows an unknown value to a canonical circuit identifier. Returns `false`
 * for hyphenated route names such as `'coinbase-kyc'`.
 */
export function isCanonicalCircuitId(value: unknown): value is CanonicalCircuitId {
  return typeof value === 'string' && (ALL_CIRCUIT_IDS as readonly string[]).includes(value);
}

/** Returns the support status of a canonical circuit. */
export function getCircuitSupportStatus(circuit: CanonicalCircuitId): CircuitSupportStatus {
  if (!isCanonicalCircuitId(circuit)) {
    throw new Error(
      `Unknown circuit '${String(circuit)}'. Expected one of: ${ALL_CIRCUIT_IDS.join(', ')}`,
    );
  }
  return CIRCUIT_SUPPORT_STATUS[circuit];
}

// ── proofport-ai's own subset ───────────────────────────────────────────────
// Everything above mirrors the customer SDK. Everything below is this repo's,
// and the SDK has no opinion on it.

/**
 * The circuits this server can actually prove: the ones it has compiled
 * artifacts, an input builder and a deployed verifier for.
 *
 * A strict subset of {@link ALL_CIRCUIT_IDS} — `satisfies` makes an id that is
 * no longer canonical a compile error here, and the entries are the canonical
 * constants rather than repeated string literals.
 *
 * Being provable is a stronger claim than being `supported`: a newly supported
 * circuit is not provable here until its artifacts, input builder and verifier
 * address land. `tests/circuitIds.test.ts` enforces the other direction — this
 * server never sells proofs for a circuit the SDK still marks `planned`.
 */
export const PROVABLE_CIRCUIT_IDS = [
  CIRCUIT_IDS.COINBASE_ATTESTATION,
  CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
  CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
] as const satisfies readonly CanonicalCircuitId[];

/**
 * A circuit proofport-ai can prove. This is what `CircuitId` has always meant in
 * this repo; it is now derived from {@link CIRCUIT_IDS} rather than re-typed.
 */
export type CircuitId = (typeof PROVABLE_CIRCUIT_IDS)[number];

/** Narrows an unknown value to a circuit this server can prove. */
export function isProvableCircuitId(value: unknown): value is CircuitId {
  return typeof value === 'string' && (PROVABLE_CIRCUIT_IDS as readonly string[]).includes(value);
}
