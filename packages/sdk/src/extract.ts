/**
 * Extract structured data from ZK proof publicInputs.
 *
 * ## The caller says which circuit; this module never guesses
 *
 * Every function here takes the circuit id explicitly. There used to be a
 * `detectCircuit(fieldCount)` that inferred the circuit from the *number* of
 * public inputs (128 → coinbase, 150 → country, 148 → oidc, anything else →
 * coinbase). It is gone. Field count is a size, not an identity: nothing
 * guarantees two circuits have different counts, and when they collide the
 * inference returns whichever branch is written first, silently, with no error.
 * A wrong answer here is a wrong nullifier, which is a correctness bug in
 * uniqueness and double-spend checks rather than a cosmetic one.
 *
 * The circuit is always available at the call site — it is in the prove request
 * and comes back in the prove response — so requiring it costs nothing and a
 * missing one now returns `null` ("I don't know") instead of a confident guess.
 *
 * ## Public-input layouts are this repo's knowledge
 *
 * The index ranges below are per-circuit facts that proofport-ai owns; the
 * customer SDK has no layout data. Only the *identifiers* come from
 * `./circuits.js` (mirroring `@zkproofport-app/sdk/circuits`).
 *
 * coinbase_attestation (128 fields):
 *   Index 0-31:   signal_hash (32 bytes)
 *   Index 32-63:  merkle_root (32 bytes)
 *   Index 64-95:  scope (32 bytes)
 *   Index 96-127: nullifier (32 bytes)
 *
 * coinbase_country_attestation (150 fields):
 *   Index 0-63:   attestation fields
 *   Index 64-83:  country_list (20 bytes)
 *   Index 84:     country_list_length
 *   Index 85:     is_included
 *   Index 86-117: scope (32 bytes)
 *   Index 118-149: nullifier (32 bytes)
 *
 * oidc_domain_attestation (148 fields):
 *   Index 0-17:    pubkey_modulus_limbs (18 x u128)
 *   Index 18-81:   domain storage (BoundedVec<u8, 64>)
 *   Index 82:      domain len
 *   Index 83-114:  scope (32 bytes)
 *   Index 115-146: nullifier (32 bytes)
 *   Index 147:     provider (u8)
 */

import { CIRCUIT_IDS } from './circuits.js';
import type { CircuitId } from './types.js';

/** Byte ranges within the public-input vector, per circuit. */
interface PublicInputLayout {
  /** Inclusive `[start, end]` field indices holding the 32-byte scope. */
  scope: readonly [number, number];
  /** Inclusive `[start, end]` field indices holding the 32-byte nullifier. */
  nullifier: readonly [number, number];
  /** First field of the domain byte storage, for circuits that carry a domain. */
  domainStorage?: number;
  /** Field holding the domain length, for circuits that carry a domain. */
  domainLen?: number;
}

/**
 * Public-input layout for every circuit proofport-ai can prove.
 *
 * Keyed by the canonical identifiers, so a rename in the customer SDK is a
 * compile error here rather than a lookup that quietly misses.
 */
const LAYOUTS: Record<CircuitId, PublicInputLayout> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: { scope: [64, 95], nullifier: [96, 127] },
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: { scope: [86, 117], nullifier: [118, 149] },
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: {
    scope: [83, 114],
    nullifier: [115, 146],
    domainStorage: 18,
    domainLen: 82,
  },
};

/**
 * Look up the public-input layout for a circuit.
 *
 * Returns `null` for anything without a known layout — including a canonical
 * identifier this server cannot prove, such as `mdl_kr_age`. It never falls
 * back to another circuit's byte ranges.
 */
function getLayout(circuit: unknown): PublicInputLayout | null {
  if (typeof circuit !== 'string') return null;
  return (LAYOUTS as Record<string, PublicInputLayout | undefined>)[circuit] ?? null;
}

/**
 * Split a concatenated hex string into 32-byte (64 hex char) fields.
 */
function splitFields(publicInputsHex: string): string[] {
  const hex = publicInputsHex.startsWith('0x') ? publicInputsHex.slice(2) : publicInputsHex;
  const fields: string[] = [];
  for (let i = 0; i < hex.length; i += 64) {
    fields.push('0x' + hex.slice(i, i + 64));
  }
  return fields;
}

/**
 * Extract 32 bytes from consecutive fields (each field = 1 byte in lower bits).
 */
function extractBytes32(fields: string[], start: number, end: number): string {
  const bytes: string[] = [];
  for (let i = start; i <= end; i++) {
    const byte = (BigInt(fields[i]) & 0xFFn).toString(16).padStart(2, '0');
    bytes.push(byte);
  }
  return '0x' + bytes.join('');
}

/**
 * Extract scope from proof publicInputs.
 *
 * @param publicInputs - Single hex string of concatenated public inputs
 * @param circuit - Canonical circuit id the proof was generated for. Required:
 *   the layout cannot be inferred from the data, and this function will not
 *   guess. JavaScript callers that omit it get `null`.
 * @returns The scope as a 0x-prefixed hex string, or `null` when the circuit is
 *   unknown or the input is too short for its layout.
 */
export function extractScopeFromPublicInputs(
  publicInputs: string,
  circuit: CircuitId,
): string | null {
  try {
    const layout = getLayout(circuit);
    if (!layout) return null;
    const fields = splitFields(publicInputs);
    const [start, end] = layout.scope;
    if (fields.length <= end) return null;
    return extractBytes32(fields, start, end);
  } catch {
    return null;
  }
}

/**
 * Extract nullifier from proof publicInputs.
 *
 * @param publicInputs - Single hex string of concatenated public inputs
 * @param circuit - Canonical circuit id the proof was generated for. Required:
 *   the layout cannot be inferred from the data, and this function will not
 *   guess. JavaScript callers that omit it get `null`.
 * @returns The nullifier as a 0x-prefixed hex string, or `null` when the circuit
 *   is unknown or the input is too short for its layout.
 */
export function extractNullifierFromPublicInputs(
  publicInputs: string,
  circuit: CircuitId,
): string | null {
  try {
    const layout = getLayout(circuit);
    if (!layout) return null;
    const fields = splitFields(publicInputs);
    const [start, end] = layout.nullifier;
    if (fields.length <= end) return null;
    return extractBytes32(fields, start, end);
  } catch {
    return null;
  }
}

/**
 * Extract the email domain from proof publicInputs.
 *
 * Only `oidc_domain_attestation` carries a domain. The circuit is a parameter
 * for the same reason as above: this function used to assume OIDC and read
 * indices 18..81 out of whatever it was handed, so a 128-field coinbase proof
 * (length 128, comfortably past its `< 83` guard) produced a plausible-looking
 * string built from unrelated attestation bytes.
 *
 * @param publicInputs - Single hex string of concatenated public inputs
 * @param circuit - Canonical circuit id the proof was generated for. Required
 *   for the same reason as the other extractors: a default would be a guess,
 *   and the compiler catching a wrong call site beats a wrong domain at runtime.
 * @returns The domain string, or `null` when the circuit carries no domain or
 *   extraction fails.
 */
export function extractDomainFromPublicInputs(
  publicInputs: string,
  circuit: CircuitId,
): string | null {
  try {
    const layout = getLayout(circuit);
    if (!layout) return null;

    const { domainStorage, domainLen } = layout;
    if (domainStorage === undefined || domainLen === undefined) return null;

    const fields = splitFields(publicInputs);
    if (fields.length <= domainLen) return null;

    const length = Number(BigInt(fields[domainLen]));
    if (length <= 0 || length > 64) return null;
    if (fields.length < domainStorage + length) return null;

    const chars: string[] = [];
    for (let i = 0; i < length; i++) {
      const byte = Number(BigInt(fields[domainStorage + i]) & 0xFFn);
      chars.push(String.fromCharCode(byte));
    }
    return chars.join('');
  } catch {
    return null;
  }
}
