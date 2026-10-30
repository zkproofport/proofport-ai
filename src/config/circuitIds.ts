/**
 * Canonical ZKProofport circuit identifiers, for the proofport-ai server.
 *
 * `@zkproofport-app/core/circuits` is the single source of truth for circuit
 * identifiers across every layer: the mobile app, the relay, the demo, this
 * server and its published client SDK. This file re-exports it and adds the one
 * thing core has no opinion on -- which of those circuits THIS server can
 * actually prove, and where each one's artifacts live.
 *
 * Core and not `@zkproofport-app/sdk`: the customer SDK re-exports the same
 * module but installs `@aztec/bb.js` (about 153 MB unpacked) for an off-chain
 * verifier this server never uses. `./circuits` is the dependency-free subpath.
 *
 * Adding a circuit means adding it to core and publishing; this server picks
 * it up on the next install. An id this server cannot prove yet stays out of
 * PROVABLE_CIRCUIT_IDS below, which is a separate, deliberate list.
 */
export {
  ALL_CIRCUIT_IDS,
  CIRCUIT_IDS,
  CIRCUIT_SUPPORT_STATUS,
  EXPERIMENTAL_CIRCUIT_IDS,
  PLANNED_CIRCUIT_IDS,
  SUPPORTED_CIRCUIT_IDS,
  getCircuitSupportStatus,
} from '@zkproofport-app/core/circuits';

import {
  ALL_CIRCUIT_IDS,
  CIRCUIT_IDS,
  circuitActionBinding,
  isCircuitId,
  type CircuitId as CoreCircuitId,
  type CircuitSupportStatus as CoreCircuitSupportStatus,
} from '@zkproofport-app/core/circuits';

/**
 * Union of every canonical circuit identifier.
 *
 * Core calls this `CircuitId`. It is `CanonicalCircuitId` here because
 * {@link CircuitId} in this repo has always meant the narrower set proofport-ai
 * can prove, and silently widening it would let
 * `circuit: 'dojang_playground'` typecheck against an endpoint that cannot
 * serve it.
 */
export type CanonicalCircuitId = CoreCircuitId;

export type CircuitSupportStatus = CoreCircuitSupportStatus;

/**
 * Narrows an unknown value to a canonical circuit identifier. Returns `false`
 * for hyphenated route names such as `'coinbase-kyc'`.
 *
 * Core's own narrowing function, re-exported under this repo's long-standing
 * name.
 */
export const isCanonicalCircuitId: (value: unknown) => value is CanonicalCircuitId = isCircuitId;

// ── proofport-ai's own subset ───────────────────────────────────────────────
// Everything above comes from core. Everything below is this repo's, and core
// has no opinion on it.

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
 * server never sells proofs for a circuit core still marks `planned`.
 */
export const PROVABLE_CIRCUIT_IDS = [
  CIRCUIT_IDS.COINBASE_ATTESTATION,
  CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
  CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
  // Added 2026-09-22, when its circuit gained the optional EIP-712 action and
  // its verifier was deployed on GIWA Sepolia. Its attestation comes from our
  // own attester on that chain, not from Coinbase's EAS -- see
  // ATTESTATION_SOURCES.
  CIRCUIT_IDS.GIWA_ATTESTATION,
  // Added 2026-10-30. Its issuance is read from the wallet's scoreV2
  // attestation on Base and its verifyAndAttest calldata, before payment
  // (src/input/humanPassport.ts).
  CIRCUIT_IDS.HUMAN_PASSPORT_SCORE,
] as const satisfies readonly CanonicalCircuitId[];

/**
 * A circuit proofport-ai can prove. This is what `CircuitId` has always meant in
 * this repo; it is now derived from {@link CIRCUIT_IDS} rather than re-typed.
 */
export type CircuitId = (typeof PROVABLE_CIRCUIT_IDS)[number];

/**
 * The provable circuits a caller may bind an EIP-712 action to, from core's
 * `circuitActionBinding` -- the one table every layer reads. Discovery text
 * lists these rather than naming circuits, so it cannot fall behind a
 * circuit gaining an action (as it did for coinbase_attestation v2).
 */
export function actionCapableCircuitIds(): CircuitId[] {
  return PROVABLE_CIRCUIT_IDS.filter(id => circuitActionBinding(id) !== 'none');
}

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
 * on 2026-09-09: a fourth circuit was added to the other two and not to the
 * script, so the script copied artifacts for three circuits, the server needed
 * four, and it crash-looped trying to download the fourth from a branch it had
 * not been pushed to yet.
 *
 * A hardcoded list of circuits fails every time a circuit is added. Read this
 * instead -- from TypeScript by importing it, and from a shell script by
 * asking node for it (see `circuitDirsJson`).
 */
/*
 * `packageName` is the compiled artifact's file name (Nargo.toml `name`). It
 * equals the canonical id for every circuit except the two Coinbase ones,
 * whose v2 is built from circuits `coinbase-attestation-v2` /
 * `coinbase-country-attestation-v2` as packages `coinbase_attestation_v2` /
 * `coinbase_country_attestation_v2` while v1 still lives beside each; the
 * circuit id each proves is still the canonical one (nullifier tag,
 * statement kind).
 */
export const CIRCUIT_DIRS: Record<CircuitId, { dir: string; packageName: string }> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: {
    dir: 'coinbase-attestation-v2',
    packageName: 'coinbase_attestation_v2',
  },
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: {
    dir: 'coinbase-country-attestation-v2',
    packageName: 'coinbase_country_attestation_v2',
  },
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: {
    dir: 'oidc-domain-attestation',
    packageName: CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
  },
  [CIRCUIT_IDS.GIWA_ATTESTATION]: {
    dir: 'giwa-attestation',
    packageName: CIRCUIT_IDS.GIWA_ATTESTATION,
  },
  [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: {
    dir: 'human-passport-score',
    packageName: CIRCUIT_IDS.HUMAN_PASSPORT_SCORE,
  },
};

/**
 * `<directory> <artifact-name> <circuit-id>` per line, for a shell script to read.
 *
 * The id is there because the artifact name is not always the id
 * (coinbase_attestation is served from coinbase_attestation_v2.json, and
 * coinbase_country_attestation from coinbase_country_attestation_v2.json), and the
 * pinned-artifact manifest the deploy writes is keyed by circuit id: keyed by
 * artifact name, the first v2 staging revision refused to start with
 * "Pinned artifact hashes are missing or invalid for coinbase_attestation"
 * (2026-10-28).
 *
 * Deliberately not JSON: a shell loop over two whitespace-separated fields
 * needs no jq, and jq is not installed everywhere this runs.
 */
export function circuitDirsLines(): string {
  return Object.entries(CIRCUIT_DIRS)
    .map(([id, c]) => `${c.dir} ${c.packageName} ${id}`)
    .join('\n');
}

/**
 * Friendly names a caller may send instead of a canonical id (the AI SDK's
 * `CircuitName`). Only the aliases live here; every provable canonical id is
 * accepted as itself by {@link resolveCircuitName}.
 */
export const CIRCUIT_ALIASES: Readonly<Record<string, CircuitId>> = Object.freeze({
  coinbase_kyc: CIRCUIT_IDS.COINBASE_ATTESTATION,
  coinbase_country: CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
  oidc_domain: CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
  human_passport: CIRCUIT_IDS.HUMAN_PASSPORT_SCORE,
});

/** The provable circuit a caller-supplied name means, or `undefined` for an unknown name. */
export function resolveCircuitName(name: unknown): CircuitId | undefined {
  if (typeof name !== 'string') return undefined;
  if (Object.hasOwn(CIRCUIT_ALIASES, name)) return CIRCUIT_ALIASES[name];
  return isProvableCircuitId(name) ? name : undefined;
}
