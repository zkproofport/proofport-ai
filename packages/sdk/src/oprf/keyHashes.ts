/**
 * The OPRF key hash a wallet credential proof must carry, per environment and
 * proof type: `@zkproofport-app/core`'s table (OPRF_KEY_HASHES,
 * getPinnedOprfKeyHash), re-exported so the SDK's OPRF step reads it through
 * one module. tests/oprfMirror.test.ts holds core's rows to the shared vectors
 * (tests/fixtures/oprf-vectors.json `network`, recomputed from the test
 * network's public key).
 *
 * Why it is pinned: a circuit accepts an answer under ANY OPRF key that is
 * consistent with itself; whoever holds that key can compute every address's
 * nullifier under it. So the client refuses an answer under any other key
 * before a proof is generated, and the verifier refuses such a proof.
 * Production has no row in core, so a production wallet proof is refused by
 * name, never given the test key.
 */
import { OPRF_CIRCUIT_IDS, type OprfCircuitId } from '@zkproofport-app/core';

export {
  OPRF_CIRCUIT_IDS,
  OPRF_ENVIRONMENTS,
  OPRF_KEY_HASHES,
  getPinnedOprfKeyHash,
  isOprfEnvironment,
  type OprfCircuitId,
  type OprfEnvironment,
} from '@zkproofport-app/core';

/** Whether `value` names a circuit whose proof carries an OPRF nullifier (one of core's OPRF_CIRCUIT_IDS). */
export function isOprfCircuitId(value: unknown): value is OprfCircuitId {
  return typeof value === 'string' && (OPRF_CIRCUIT_IDS as readonly string[]).includes(value);
}
