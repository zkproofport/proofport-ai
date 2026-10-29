/**
 * Canonical ZKProofport circuit identifiers, for `@zkproofport-ai/sdk`.
 *
 * `@zkproofport-app/core/circuits` is the single source of truth for circuit
 * identifiers across every layer: the mobile app, the relay, the demo, the
 * proofport-ai server and this package. Everything canonical here is
 * re-exported from it.
 *
 * Until core existed this file was a hand-kept mirror, because the only
 * published home of the list was `@zkproofport-app/sdk`, whose dependency tree
 * is a poor trade on every `npx zkproofport-mcp`. Core's `./circuits` subpath
 * has no dependencies, so the mirror and the test that compared it are gone.
 *
 * What stays is this package's own subset -- the circuits the proofport-ai
 * server can prove -- which core has no opinion on.
 */
import { CIRCUIT_IDS, circuitActionBinding, type CircuitId as CoreCircuitId } from '@zkproofport-app/core/circuits';

export {
  CIRCUIT_IDS,
  CIRCUIT_SUPPORT_STATUS,
  ALL_CIRCUIT_IDS,
  SUPPORTED_CIRCUIT_IDS,
  EXPERIMENTAL_CIRCUIT_IDS,
  PLANNED_CIRCUIT_IDS,
  getCircuitSupportStatus,
  isCircuitId as isCanonicalCircuitId,
} from '@zkproofport-app/core/circuits';
export type { CircuitSupportStatus } from '@zkproofport-app/core/circuits';

/**
 * Union of every canonical circuit identifier.
 *
 * Core calls this type `CircuitId`. It is named `CanonicalCircuitId` here
 * because {@link CircuitId} is already this package's public name for the
 * narrower set proofport-ai can prove; widening it would be a silent breaking
 * change for anyone writing `Record<CircuitId, ...>`, and would let
 * `circuit: 'dojang_playground'` typecheck against an endpoint that cannot serve it.
 */
export type CanonicalCircuitId = CoreCircuitId;

// ── proofport-ai's own subset ───────────────────────────────────────────────

/**
 * The circuits the proofport-ai server can prove: the ones it has compiled
 * artifacts, an input builder and a deployed verifier for.
 *
 * A strict subset of core's ids -- `satisfies` makes an id that is no longer
 * canonical a compile error here. The server keeps the same list in
 * `src/config/circuitIds.ts`; the two trees ship separately and cannot import
 * each other, so `tests/circuitIds.test.ts` holds them equal.
 */
export const PROVABLE_CIRCUIT_IDS = [
  CIRCUIT_IDS.COINBASE_ATTESTATION,
  CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
  CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
  CIRCUIT_IDS.GIWA_ATTESTATION,
] as const satisfies readonly CanonicalCircuitId[];

/** Narrows an unknown value to a circuit the proofport-ai server can prove. */
export function isProvableCircuitId(value: unknown): value is CanonicalCircuitId {
  return typeof value === 'string' && (PROVABLE_CIRCUIT_IDS as readonly string[]).includes(value);
}

/**
 * Whether a caller may bind an EIP-712 action to this circuit's proof.
 *
 * Read from core's `circuitActionBinding`, the one table every layer uses
 * (server, approval page, SDK, MCP). It used to be `circuit ===
 * 'giwa_attestation'` in four places, so a second action-capable circuit
 * (coinbase_attestation v2) would have needed four edits and got some of
 * them. core marks coinbase_attestation 'optional' from its v2 release; until
 * then this answers false for it and the circuit's action inputs are zeros.
 */
export function circuitBindsAction(circuitId: CoreCircuitId): boolean {
  return circuitActionBinding(circuitId) !== 'none';
}
