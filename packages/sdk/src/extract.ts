/**
 * Extract structured data from ZK proof publicInputs.
 *
 * ## The caller says which circuit; this module never guesses
 *
 * Every function here takes the circuit id explicitly. There used to be a
 * `detectCircuit(fieldCount)` that inferred the circuit from the *number* of
 * public inputs (128 → coinbase, 150 → country, 148 → oidc v1, anything else →
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
 * ## Where the layouts come from
 *
 * The wallet circuits' OPRF values are read with `@zkproofport-app/core`'s
 * `readOprfPublicInputs` (its OPRF_PUBLIC_INPUT_LAYOUTS: the exact count,
 * superseded counts refused, every value a field element below p). These
 * functions keep their own contract on top: they take the server's one
 * concatenated hex string and answer `null` for anything this server cannot
 * prove or core refuses, where core throws. OIDC's byte ranges below are
 * still written here; core's OIDC extractors take an array and throw.
 *
 * Wallet circuits (the OPRF nullifier; every value below is ONE field; for
 * reading, core's table decides):
 *   coinbase_attestation (133):         signal_hash 0-31, domain_separator 32-63,
 *                                       action_hash 64-95, signer root 96-127,
 *                                       oprf_key_hash 128, domain 129, scope 130,
 *                                       nullifier 131, attested_at 132
 *   coinbase_country_attestation (155): 0-127 as above, country_list 128-147,
 *                                       length 148, is_included 149, OPRF 150-153,
 *                                       attested_at 154
 *   giwa_attestation (132):             0-127 as above, OPRF 128-131
 *   human_passport_score (135):         0-127 as above, OPRF 128-131, min_score 132,
 *                                       scorer_id 133, now 134
 *
 * oidc_domain_attestation (214 fields, circuit v2; 0-147 are v1's, unchanged):
 *   Index 0-17:    pubkey_modulus_limbs (18 x u128)
 *   Index 18-81:   domain storage (BoundedVec<u8, 64>)
 *   Index 82:      domain len
 *   Index 83-114:  scope (32 bytes)
 *   Index 115-146: nullifier (32 bytes)
 *   Index 147:     provider (u8)
 *   Index 148-179: aud_hash (32 bytes, keccak256 of the token's aud)
 *   Index 180:     nonce_mode (u8; 0 for proofs from this server's device flow)
 *   Index 181-212: nonce_binding (32 bytes; all zero in nonce_mode 0)
 *   Index 213:     now (u64 unix seconds; iat <= now < exp)
 */

import { readOprfPublicInputs, type OprfPublicInputs } from '@zkproofport-app/core';
import { CIRCUIT_IDS } from './circuits.js';
import type { CircuitId } from './types.js';

/**
 * Where scope and nullifier sit, per circuit. Two shapes:
 *
 * - `oprf`: the wallet circuits since the OPRF nullifier (circuits-dev.md,
 *   "OPRF nullifier in every wallet credential circuit"). Their offsets and
 *   exact count are core's (`readOprfPublicInputs`), so a proof in a
 *   superseded layout reads as null rather than as other values.
 * - `bytes`: OIDC, whose scope and nullifier are still 32 one-byte fields.
 */
type PublicInputLayout =
  | { kind: 'oprf' }
  | {
      kind: 'bytes';
      /** Inclusive `[start, end]` field indices holding the 32-byte scope. */
      scope: readonly [number, number];
      /** Inclusive `[start, end]` field indices holding the 32-byte nullifier. */
      nullifier: readonly [number, number];
      domainStorage: number;
      domainLen: number;
    };

/**
 * Public-input layout for every circuit proofport-ai can prove, keyed by the
 * canonical identifiers so a rename is a compile error here.
 */
const LAYOUTS: Record<CircuitId, PublicInputLayout> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: { kind: 'oprf' },
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: { kind: 'oprf' },
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: {
    kind: 'bytes',
    scope: [83, 114],
    nullifier: [115, 146],
    domainStorage: 18,
    domainLen: 82,
  },
  [CIRCUIT_IDS.GIWA_ATTESTATION]: { kind: 'oprf' },
  [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: { kind: 'oprf' },
};

/** Which of core's four OPRF values each reader returns. */
const OPRF_VALUE: Readonly<Record<'keyHash' | 'domain' | 'scope' | 'nullifier', keyof OprfPublicInputs>> = Object.freeze({
  keyHash: 'oprfKeyHash',
  domain: 'domain',
  scope: 'scope',
  nullifier: 'nullifier',
});

/** The layout for a circuit, or null (never another circuit's) for anything unknown, e.g. dojang_playground. */
function getLayout(circuit: unknown): PublicInputLayout | null {
  if (typeof circuit !== 'string' || !Object.hasOwn(LAYOUTS, circuit)) return null;
  return LAYOUTS[circuit as CircuitId];
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
  return readValue(publicInputs, circuit, 'scope');
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
  return readValue(publicInputs, circuit, 'nullifier');
}

/**
 * The OPRF domain (keccak256(utf8(name)) mod p, 0x + 64 hex) of a wallet
 * circuit's proof; null for OIDC, an unknown circuit or a malformed input.
 */
export function extractOprfDomainFromPublicInputs(publicInputs: string, circuit: CircuitId): string | null {
  return readOprf(publicInputs, circuit, 'domain');
}

/** The OPRF key hash a wallet circuit's proof carries; null otherwise. Compare it with getPinnedOprfKeyHash. */
export function extractOprfKeyHashFromPublicInputs(publicInputs: string, circuit: CircuitId): string | null {
  return readOprf(publicInputs, circuit, 'keyHash');
}

function readOprf(publicInputs: string, circuit: CircuitId, which: keyof typeof OPRF_VALUE): string | null {
  try {
    const layout = getLayout(circuit);
    if (!layout || layout.kind !== 'oprf') return null;
    const fields = splitFields(publicInputs);
    if (fields.some(f => !/^0x[0-9a-fA-F]{64}$/.test(f))) return null;
    return readOprfPublicInputs(circuit, fields)[OPRF_VALUE[which]];
  } catch {
    return null;
  }
}

function readValue(publicInputs: string, circuit: CircuitId, which: 'scope' | 'nullifier'): string | null {
  try {
    const layout = getLayout(circuit);
    if (!layout) return null;
    if (layout.kind === 'oprf') return readOprf(publicInputs, circuit, which);
    const fields = splitFields(publicInputs);
    const [start, end] = layout[which];
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

    if (layout.kind !== 'bytes') return null;
    const { domainStorage, domainLen } = layout;

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
