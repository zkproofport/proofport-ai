/**
 * The OPRF nullifier as the E2E suites see it: one name for the service the
 * proofs are for, and one check of the four OPRF public inputs a wallet
 * circuit's proof carries.
 *
 * Offsets and counts come from @zkproofport-app/core's layout table
 * (oprfLayoutOf), never from literals here, so a circuit change that moves
 * them is caught by the proof, not hidden by a stale number.
 */
import { expect } from 'vitest';
import { oprfLayoutOf, getPinnedOprfKeyHash, OPRF_FIELD_MODULUS, type OprfEnvironment } from '@zkproofport-app/core';
import { reduceOprfName } from '@zkproofport-app/core/oprf';

/** The service every E2E proof is made for (the caller's OPRF domain; the SDK never fills it in Node). */
export const E2E_OPRF_DOMAIN = 'e2e.zkproofport.test';

/** A proof's flat public inputs (one 0x-hex string) as 32-byte words. */
export function publicInputFields(publicInputsHex: string): string[] {
  expect(publicInputsHex).toMatch(/^0x([0-9a-fA-F]{64})+$/);
  return publicInputsHex.slice(2).match(/.{64}/g)!.map(w => '0x' + w.toLowerCase());
}

/**
 * Check the OPRF public inputs of a `circuit` proof: the count is the
 * circuit's, the key hash is the one pinned for `environment`, the domain and
 * scope are the request's names reduced to fields, and the nullifier is a
 * non-zero field element.
 *
 * @returns the nullifier (0x + 64 hex)
 */
export function expectOprfPublicInputs(
  f: readonly string[],
  circuit: string,
  request: { scope: string; oprfDomain: string; environment: OprfEnvironment },
): string {
  const layout = oprfLayoutOf(circuit);
  expect(f.length, `${circuit} public input count`).toBe(layout.count);
  expect(f[layout.keyHash]).toBe(getPinnedOprfKeyHash(request.environment, circuit).toLowerCase());
  expect(f[layout.domain]).toBe(reduceOprfName(request.oprfDomain).toLowerCase());
  expect(f[layout.scope]).toBe(reduceOprfName(request.scope).toLowerCase());
  const nullifier = f[layout.nullifier];
  expect(BigInt(nullifier)).not.toBe(0n);
  expect(BigInt(nullifier) < OPRF_FIELD_MODULUS).toBe(true);
  return nullifier;
}
