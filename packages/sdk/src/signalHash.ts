/**
 * The `signal_hash` a wallet credential proof carries when no EIP-712 action is
 * bound.
 *
 *   signal_hash = keccak256(abi.encodePacked(string scope, string circuitId, string requestId))
 *
 * The rule, its validation and its circuit list are `@zkproofport-app/core`'s
 * (`computeSignalHash`, `signalHashScopeError`, `signalHashRequestIdError`,
 * `SIGNAL_HASH_CIRCUIT_IDS`). tests/signalHash.test.ts holds them to the
 * shared vectors (tests/fixtures/signal-hash-vectors.json, byte-identical to
 * core's).
 *
 * What this module adds:
 * - `computeSignalHash` returns the 32 BYTES. Core returns them as 0x-hex. The
 *   wallet personal_signs the bytes; handing a hex string to `signMessage`
 *   would sign its 66 UTF-8 characters instead, a different message the
 *   circuit refuses. So the SDK keeps the byte form under the name its callers
 *   and README use.
 * - the request id this SDK and the MCP mint when the caller has none.
 *
 * The wallet address left the preimage on 2026-11-17: signal_hash is public,
 * and with the address in it anyone could try every attested address and
 * recover the prover. The nullifier now comes from the OPRF and no circuit
 * reads this preimage. `requestId` makes the hash fresh per request, and lets
 * the relying party that issued the request recompute and check it.
 *
 * The server does not compute signal_hash; its input builder takes the value
 * its caller computed here.
 */
import { ethers } from 'ethers';
import { computeSignalHash as coreComputeSignalHash, signalHashRequestIdError } from '@zkproofport-app/core';

export {
  SIGNAL_HASH_CIRCUIT_IDS,
  SIGNAL_HASH_MAX_REQUEST_ID_LENGTH,
  SIGNAL_HASH_MAX_SCOPE_BYTES,
  signalHashRequestIdError,
  signalHashScopeError,
} from '@zkproofport-app/core';

/**
 * The signal_hash a proof without an action carries for this request, as the
 * 32 bytes the wallet signs.
 *
 * @throws Error naming the problem (core's): an unknown circuit id, a circuit
 *   with no signal_hash, or a scope / requestId outside the rules.
 */
export function computeSignalHash(request: { scope: string; circuitId: string; requestId: string }): Uint8Array {
  return ethers.getBytes(coreComputeSignalHash(request));
}

/**
 * A fresh request id for a proof no relying party issued one for: a lowercase
 * UUID v4 from the platform's secure random source. Never a constant.
 */
export function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c?.randomUUID) throw new Error('No secure random source (crypto.randomUUID) to mint a request id.');
  return c.randomUUID().toLowerCase();
}

/**
 * The request id to bind: the caller's, checked; otherwise a fresh one.
 * @throws Error when the caller's id breaks the rules.
 */
export function resolveRequestId(requestId: unknown): string {
  if (requestId === undefined) return newRequestId();
  const error = signalHashRequestIdError(requestId);
  if (error) throw new Error(error);
  return requestId as string;
}
