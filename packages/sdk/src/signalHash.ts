/**
 * The `signal_hash` a wallet credential proof carries when no EIP-712 action is
 * bound.
 *
 *   signal_hash = keccak256(abi.encodePacked(string scope, string circuitId, string requestId))
 *
 * MIRROR of `computeSignalHash` in `@zkproofport-app/core`
 * (proofport-app-sdk packages/core/src/signalHash.ts). The published core this
 * repository pins (0.4.0-beta.8) does not ship it yet; once a later core
 * release does, delete this file and import it from core. Until then
 * tests/signalHash.test.ts holds this copy to the shared vectors
 * (tests/fixtures/signal-hash-vectors.json, byte-identical to core's).
 *
 * The wallet address left the preimage on 2026-11-17: signal_hash is public,
 * and with the address in it anyone could try every attested address and
 * recover the prover. The nullifier now comes from the OPRF and no circuit
 * reads this preimage. `requestId` makes the hash fresh per request, and lets
 * the relying party that issued the request recompute and check it.
 *
 * This is the ONLY implementation in proofport-ai. The server does not compute
 * signal_hash; its input builder takes the value its caller computed here.
 */
import { ethers } from 'ethers';
import { ALL_CIRCUIT_IDS, isCanonicalCircuitId, type CanonicalCircuitId } from './circuits.js';

/** Scope cap in UTF-8 bytes (core's SIGNAL_HASH_MAX_SCOPE_BYTES). */
export const SIGNAL_HASH_MAX_SCOPE_BYTES = 4096;

/** Request id cap in characters (core's SIGNAL_HASH_MAX_REQUEST_ID_LENGTH). */
export const SIGNAL_HASH_MAX_REQUEST_ID_LENGTH = 128;

const REQUEST_ID = /^[A-Za-z0-9-]+$/;

/** Which circuits carry a signal_hash. OIDC binds its request through the ID token's nonce instead. */
const HAS_SIGNAL_HASH: Readonly<Record<CanonicalCircuitId, boolean>> = Object.freeze({
  coinbase_attestation: true,
  coinbase_country_attestation: true,
  oidc_domain_attestation: false,
  giwa_attestation: true,
  dojang_playground: true,
  human_passport_score: true,
});

export const SIGNAL_HASH_CIRCUIT_IDS: readonly CanonicalCircuitId[] = Object.freeze(
  ALL_CIRCUIT_IDS.filter(id => HAS_SIGNAL_HASH[id]),
);

function loneSurrogateAt(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return i;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return i;
  }
  return -1;
}

/** Why this scope cannot be hashed, or null. */
export function signalHashScopeError(scope: unknown): string | null {
  if (typeof scope !== 'string') return `scope must be a string, got ${scope === null ? 'null' : typeof scope}.`;
  if (scope.trim() === '') return 'scope is empty.';
  const at = loneSurrogateAt(scope);
  if (at >= 0) return `scope is not valid Unicode text: unpaired surrogate at index ${at}.`;
  const bytes = new TextEncoder().encode(scope).length;
  if (bytes > SIGNAL_HASH_MAX_SCOPE_BYTES) return `scope is ${bytes} bytes; the limit is ${SIGNAL_HASH_MAX_SCOPE_BYTES}.`;
  return null;
}

/** Why this request id cannot be hashed, or null. */
export function signalHashRequestIdError(requestId: unknown): string | null {
  if (typeof requestId !== 'string') {
    return `requestId must be a string, got ${requestId === null ? 'null' : typeof requestId}.`;
  }
  if (requestId.length === 0) return 'requestId is empty.';
  if (requestId.length > SIGNAL_HASH_MAX_REQUEST_ID_LENGTH) {
    return `requestId is ${requestId.length} characters; the limit is ${SIGNAL_HASH_MAX_REQUEST_ID_LENGTH}.`;
  }
  if (!REQUEST_ID.test(requestId)) {
    return `requestId may hold only ASCII letters, digits and '-', got ${JSON.stringify(requestId)}.`;
  }
  return null;
}

/**
 * The signal_hash a proof without an action carries for this request (32 bytes).
 *
 * @throws Error naming the problem: an unknown circuit id, a circuit with no
 *   signal_hash, or a scope / requestId outside the rules above.
 */
export function computeSignalHash(request: { scope: string; circuitId: string; requestId: string }): Uint8Array {
  const { circuitId } = request;
  if (!isCanonicalCircuitId(circuitId)) {
    throw new Error(`Unknown circuit '${String(circuitId)}'. Known: ${ALL_CIRCUIT_IDS.join(', ')}.`);
  }
  if (!HAS_SIGNAL_HASH[circuitId]) {
    throw new Error(`${circuitId} has no signal_hash. Circuits that do: ${SIGNAL_HASH_CIRCUIT_IDS.join(', ')}.`);
  }
  const scopeError = signalHashScopeError(request.scope);
  if (scopeError) throw new Error(scopeError);
  const idError = signalHashRequestIdError(request.requestId);
  if (idError) throw new Error(idError);
  const packed = ethers.concat([
    ethers.toUtf8Bytes(request.scope),
    ethers.toUtf8Bytes(circuitId),
    ethers.toUtf8Bytes(request.requestId),
  ]);
  return ethers.getBytes(ethers.keccak256(packed));
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

