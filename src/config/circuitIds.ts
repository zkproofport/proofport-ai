/**
 * Canonical ZKProofport circuit identifiers, for the proofport-ai server.
 *
 * ## The customer SDK owns this list, and this file now imports it
 *
 * `@zkproofport-app/sdk/circuits` is the single source of truth for circuit
 * identifiers across every layer: the mobile app, the relay, the demo, and this
 * server. This file re-exports it and adds the one thing the SDK has no opinion
 * on — which of those circuits THIS server can actually prove.
 *
 * ## It used to be a copy
 *
 * Until 2026-09-11 the ids below were typed out again here, with a note calling
 * the file "a mirror, not a second source of truth" and two reasons the import
 * could not resolve: that the published SDK did not ship the module, and that a
 * sibling `file:` link could not reach across repositories.
 *
 * The first reason had expired. `@zkproofport-app/sdk@0.2.16` exports
 * `./circuits` — checked by reading its `exports` map and loading it — so the
 * dependency resolves from the registry like any other and the Docker build and
 * the npm tarballs are unaffected. A copy that has to be kept in step by hand
 * is a second source of truth however the comment describes it, so it is gone.
 *
 * Adding a circuit now means adding it to the SDK and publishing; this server
 * picks it up on the next install. An id this server cannot prove yet stays out
 * of PROVABLE_CIRCUIT_IDS below, which is a separate, deliberate list.
 */
export {
  ALL_CIRCUIT_IDS,
  CIRCUIT_IDS,
  CIRCUIT_SUPPORT_STATUS,
  EXPERIMENTAL_CIRCUIT_IDS,
  PLANNED_CIRCUIT_IDS,
  SUPPORTED_CIRCUIT_IDS,
  getCircuitSupportStatus,
} from '@zkproofport-app/sdk/circuits';

import {
  ALL_CIRCUIT_IDS,
  CIRCUIT_IDS,
  isCircuitId,
  type CircuitId as SdkCircuitId,
  type CircuitSupportStatus as SdkCircuitSupportStatus,
} from '@zkproofport-app/sdk/circuits';

/**
 * Union of every canonical circuit identifier.
 *
 * The SDK calls this `CircuitId`. It is `CanonicalCircuitId` here because
 * {@link CircuitId} in this repo has always meant the narrower set proofport-ai
 * can prove, and silently widening it would let `circuit: 'mdl_kr_age'`
 * typecheck against an endpoint that cannot serve it.
 */
export type CanonicalCircuitId = SdkCircuitId;

export type CircuitSupportStatus = SdkCircuitSupportStatus;

/**
 * Narrows an unknown value to a canonical circuit identifier. Returns `false`
 * for hyphenated route names such as `'coinbase-kyc'`.
 *
 * The SDK's own narrowing function, re-exported under this repo's long-standing
 * name.
 */
export const isCanonicalCircuitId: (value: unknown) => value is CanonicalCircuitId = isCircuitId;

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
  CIRCUIT_IDS.ARC_ELIGIBILITY,
  // Added 2026-09-22, when its circuit gained the optional EIP-712 action and
  // its verifier was deployed on GIWA Sepolia. Its attestation comes from our
  // own attester on that chain, not from Coinbase's EAS -- see
  // ATTESTATION_SOURCES.
  CIRCUIT_IDS.GIWA_ATTESTATION,
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

/**
 * Where each circuit's files live, and what its compiled artifact is called.
 *
 * One copy. It existed twice -- `repoDir` in `src/circuit/artifactManager.ts`
 * and `dir` in `src/prover/bbProver.ts`, the same three values under two field
 * names -- and `scripts/ai-dev.sh` held a third copy as a hardcoded list of
 * three circuit directories. That third copy is how the local container broke
 * on 2026-09-09: `arc_eligibility` was added to the other two and not to the
 * script, so the script copied artifacts for three circuits, the server needed
 * four, and it crash-looped trying to download the fourth from a branch it had
 * not been pushed to yet.
 *
 * A hardcoded list of circuits fails every time a circuit is added. Read this
 * instead -- from TypeScript by importing it, and from a shell script by
 * asking node for it (see `circuitDirsJson`).
 */
export const CIRCUIT_DIRS: Record<CircuitId, { dir: string; packageName: CircuitId }> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: {
    dir: 'coinbase-attestation',
    packageName: CIRCUIT_IDS.COINBASE_ATTESTATION,
  },
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: {
    dir: 'coinbase-country-attestation',
    packageName: CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
  },
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: {
    dir: 'oidc-domain-attestation',
    packageName: CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
  },
  [CIRCUIT_IDS.ARC_ELIGIBILITY]: {
    dir: 'arc-eligibility',
    packageName: CIRCUIT_IDS.ARC_ELIGIBILITY,
  },
  [CIRCUIT_IDS.GIWA_ATTESTATION]: {
    dir: 'giwa-attestation',
    packageName: CIRCUIT_IDS.GIWA_ATTESTATION,
  },
};

/**
 * `<directory> <artifact-name>` per line, for a shell script to read.
 *
 * Deliberately not JSON: a shell loop over two whitespace-separated fields
 * needs no jq, and jq is not installed everywhere this runs.
 */
export function circuitDirsLines(): string {
  return Object.values(CIRCUIT_DIRS)
    .map((c) => `${c.dir} ${c.packageName}`)
    .join('\n');
}
