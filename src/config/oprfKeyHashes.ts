/**
 * The OPRF key hash a wallet credential proof must carry, per environment and
 * proof type, and the server's OPRF environment.
 *
 * The table and its lookup are `@zkproofport-app/core`'s (OPRF_KEY_HASHES,
 * getPinnedOprfKeyHash), re-exported here so the server reads them through
 * one module. tests/serverOprfKeyHashes.test.ts holds core's rows to
 * tests/fixtures/oprf-vectors.json (byte-identical to core's copy) and their
 * refusals to what this server relies on.
 *
 * Why a key hash is pinned: the circuit accepts an OPRF answer from ANY key
 * consistent with itself. A proof under another key proves nothing about the
 * nullifier, so the verifier compares the proof's `oprf_key_hash` with the
 * pinned row. This server compares it BEFORE payment, so a proof every
 * verifier would refuse is never charged for. Production has no row in core:
 * every wallet credential request is refused there, by name, never given the
 * test key.
 */
import { OPRF_CIRCUIT_IDS, OPRF_ENVIRONMENTS, isOprfEnvironment, type OprfCircuitId, type OprfEnvironment } from '@zkproofport-app/core';

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
