/**
 * The OPRF inputs of a request the enclave decrypted itself (nitro mode).
 *
 * The host cannot read an encrypted payload, so before 2026-11-20 it checked
 * only its own environment and the enclave only the values' shape: an answer
 * under any OPRF key was proved, and the verifier refused it afterwards. Now
 * the enclave applies the same check the host applies to plaintext requests
 * (src/input/oprfInputs.ts readOprfInputs): each value's shape and modulus,
 * and the key hash pinned for ITS OWN `OPRF_ENVIRONMENT` and the circuit.
 * Unset, unknown or production (no key) -> refused by name. The environment
 * is the enclave's, never one a request names.
 */
import { parseOprfEnvironment } from '../config/oprfKeyHashes.js';
import { readOprfInputs, type OprfCircuitInputs } from '../input/oprfInputs.js';

export function enclaveOprfInputs(
  environmentVariable: string | undefined,
  circuitId: string,
  inputs: unknown,
): OprfCircuitInputs {
  return readOprfInputs(parseOprfEnvironment(environmentVariable), circuitId, inputs);
}
