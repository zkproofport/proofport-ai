/**
 * Canonical ZKProofport circuit identifiers, for `@zkproofport-ai/sdk`.
 *
 * ## The customer SDK owns this list
 *
 * `@zkproofport-app/sdk/circuits` (repo `zkproofport/proofport-app-sdk`,
 * `src/circuits.ts`) is the single source of truth for circuit identifiers
 * across every layer: the mobile app, the relay, the demo, and proofport-ai.
 * The names below are that module's values, verbatim — the same eight ids in
 * the same order with the same support statuses.
 *
 * This file is a **mirror, not a second source of truth**. Nothing here may be
 * edited on its own judgement: change the SDK first, then bring the change over.
 *
 * ## Why this package keeps a copy
 *
 * There are two reasons, and only the first is temporary:
 *
 1. ~~The published customer SDK does not ship the module.~~ **No longer true**
 *    as of 0.2.16, whose `exports` map carries `./circuits` and whose tarball
 *    has `dist/circuits.{js,esm.js,mjs,d.ts}` — verified with `npm pack`
 *    2026-09-11. Reason 2 is now the only one holding this mirror up.
 * 2. This package is published to npm, and `@zkproofport-app/sdk` carries
 *    `qrcode` and `socket.io-client` (38 transitive packages, measured). The
 *    `./circuits` subpath is dependency-free at *import* time, but npm still
 *    installs the whole dependency tree. Paying that on every
 *    `npx zkproofport-mcp` for seven strings is a poor trade, so even after the
 *    SDK publishes the subpath this mirror may be worth keeping.
 *
 * The root server tree keeps its own mirror at `src/config/circuitIds.ts` — the
 * two trees are compiled and shipped separately (`rootDir: src` in each,
 * different npm packages / Docker images), so neither can import the other.
 *
 * ## What stops the mirrors drifting
 *
 * `tests/circuitIds.test.ts` at the repo root reads the real customer SDK — the
 * installed package if present, otherwise the sibling checkout at
 * `../proofport-app-sdk` — and fails when either mirror disagrees with it, or
 * with the other. It fails, rather than skips, when it can find neither.
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
export type CircuitSupportStatus = 'supported' | 'experimental' | 'planned';

/**
 * Every canonical circuit identifier ZKProofport has assigned, keyed by a stable
 * constant name. Mirrors `CIRCUIT_IDS` in `@zkproofport-app/sdk/circuits`.
 *
 * This is the full ZKProofport catalogue, which is wider than what the
 * proofport-ai server can prove — see {@link PROVABLE_CIRCUIT_IDS} for that.
 */
export const CIRCUIT_IDS = Object.freeze({
  /** Coinbase KYC attestation. Officially supported. */
  COINBASE_ATTESTATION: 'coinbase_attestation',
  /** Coinbase country attestation (inclusion / exclusion). Officially supported. */
  COINBASE_COUNTRY_ATTESTATION: 'coinbase_country_attestation',
  /** OIDC email-domain attestation. Officially supported. */
  OIDC_DOMAIN_ATTESTATION: 'oidc_domain_attestation',
  /** Arc eligibility: one EIP-712 action, authorized. Officially supported. */
  ARC_ELIGIBILITY: 'arc_eligibility',
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
 * `CanonicalCircuitId` here because {@link CircuitId} is already this package's
 * public name for the narrower set proofport-ai can prove; widening it would be
 * a silent breaking change for anyone writing `Record<CircuitId, …>`, and would
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
    arc_eligibility: 'experimental',
    // Experimental since 2026-09-22: built, deployed on GIWA Sepolia and
    // provable here. Testnet-only, which is what keeps it out of 'supported'.
    giwa_attestation: 'experimental',
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
 * The circuits the proofport-ai server can prove: the ones it has compiled
 * artifacts, an input builder and a deployed verifier for.
 *
 * A strict subset of {@link ALL_CIRCUIT_IDS} — `satisfies` makes an id that is
 * no longer canonical a compile error here, and the entries are the canonical
 * constants rather than repeated string literals.
 */
export const PROVABLE_CIRCUIT_IDS = [
  CIRCUIT_IDS.COINBASE_ATTESTATION,
  CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
  CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
  CIRCUIT_IDS.ARC_ELIGIBILITY,
  // Added 2026-09-22 with the server's own list, which a test holds byte
  // identical to this one: the two trees ship separately and cannot import
  // each other, so nothing else stops one moving without the other.
  CIRCUIT_IDS.GIWA_ATTESTATION,
] as const satisfies readonly CanonicalCircuitId[];

/** Narrows an unknown value to a circuit the proofport-ai server can prove. */
export function isProvableCircuitId(value: unknown): value is CanonicalCircuitId {
  return typeof value === 'string' && (PROVABLE_CIRCUIT_IDS as readonly string[]).includes(value);
}
