/**
 * Extract structured data from ZK proof publicInputs.
 *
 * Supports all circuit types:
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

// Circuit layouts
const LAYOUTS = {
  coinbase_attestation: { scope: [64, 95], nullifier: [96, 127] },
  coinbase_country_attestation: { scope: [86, 117], nullifier: [118, 149] },
  oidc_domain_attestation: { scope: [83, 114], nullifier: [115, 146], domainStorage: 18, domainLen: 82 },
} as const;

type CircuitType = keyof typeof LAYOUTS;

/**
 * Detect circuit type from field count.
 */
function detectCircuit(fieldCount: number): CircuitType {
  if (fieldCount === 148) return 'oidc_domain_attestation';
  if (fieldCount === 150) return 'coinbase_country_attestation';
  return 'coinbase_attestation';
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
 * Auto-detects circuit from field count.
 *
 * @param publicInputs - Single hex string of concatenated public inputs
 * @param circuit - Optional circuit type override
 * @returns The scope as a 0x-prefixed hex string, or null if extraction fails
 */
export function extractScopeFromPublicInputs(publicInputs: string, circuit?: string): string | null {
  try {
    const fields = splitFields(publicInputs);
    const ct = (circuit as CircuitType) || detectCircuit(fields.length);
    const layout = LAYOUTS[ct] || LAYOUTS.coinbase_attestation;
    const [start, end] = layout.scope;
    if (fields.length <= end) return null;
    return extractBytes32(fields, start, end);
  } catch {
    return null;
  }
}

/**
 * Extract nullifier from proof publicInputs.
 * Auto-detects circuit from field count.
 *
 * @param publicInputs - Single hex string of concatenated public inputs
 * @param circuit - Optional circuit type override
 * @returns The nullifier as a 0x-prefixed hex string, or null if extraction fails
 */
export function extractNullifierFromPublicInputs(publicInputs: string, circuit?: string): string | null {
  try {
    const fields = splitFields(publicInputs);
    const ct = (circuit as CircuitType) || detectCircuit(fields.length);
    const layout = LAYOUTS[ct] || LAYOUTS.coinbase_attestation;
    const [start, end] = layout.nullifier;
    if (fields.length <= end) return null;
    return extractBytes32(fields, start, end);
  } catch {
    return null;
  }
}

/**
 * Extract domain from oidc_domain_attestation proof publicInputs.
 *
 * @param publicInputs - Single hex string of concatenated public inputs
 * @returns The domain string, or null if not OIDC circuit or extraction fails
 */
export function extractDomainFromPublicInputs(publicInputs: string): string | null {
  try {
    const fields = splitFields(publicInputs);
    if (fields.length < 83) return null;

    const domainLen = Number(BigInt(fields[82]));
    if (domainLen <= 0 || domainLen > 64) return null;

    const chars: string[] = [];
    for (let i = 0; i < domainLen; i++) {
      const byte = Number(BigInt(fields[18 + i]) & 0xFFn);
      chars.push(String.fromCharCode(byte));
    }
    return chars.join('');
  } catch {
    return null;
  }
}
