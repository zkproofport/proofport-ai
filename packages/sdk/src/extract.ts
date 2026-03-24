/**
 * Extract structured data from oidc_domain_attestation proof publicInputs.
 *
 * Layout (148 fields, each 32 bytes):
 *   Index 0-17:    pubkey_modulus_limbs (18 x u128)
 *   Index 18-81:   domain storage (BoundedVec<u8, 64> storage, 64 bytes)
 *   Index 82:      domain len (BoundedVec len field)
 *   Index 83-114:  scope (32 bytes)
 *   Index 115-146: nullifier (32 bytes)
 *   Index 147:     provider (u8)
 */

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
 * Extract domain from oidc_domain_attestation proof publicInputs.
 *
 * Noir BoundedVec<u8, 64> layout: storage[0..64] at field indices 18-81, len at field index 82.
 * Each field's lower byte is the ASCII character.
 *
 * @param publicInputs - Single hex string (0x prefixed) of concatenated public inputs
 * @returns The domain string, or null if extraction fails
 */
export function extractDomainFromPublicInputs(publicInputs: string): string | null {
  try {
    const fields = splitFields(publicInputs);

    // Need at least 83 fields (indices 0-82)
    if (fields.length < 83) {
      return null;
    }

    // Read domain length from field index 82
    const domainLen = Number(BigInt(fields[82]));
    if (domainLen <= 0 || domainLen > 64) {
      return null;
    }

    // Read domain bytes from field indices 18..18+domainLen
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

/**
 * Extract nullifier from oidc_domain_attestation proof publicInputs.
 *
 * Nullifier is stored at field indices 115-146 (32 bytes).
 * The result is a hex string representing the 32-byte nullifier.
 *
 * @param publicInputs - Single hex string (0x prefixed) of concatenated public inputs
 * @returns The nullifier as a 0x-prefixed hex string, or null if extraction fails
 */
export function extractNullifierFromPublicInputs(publicInputs: string): string | null {
  try {
    const fields = splitFields(publicInputs);

    // Need at least 147 fields (indices 0-146)
    if (fields.length < 147) {
      return null;
    }

    // Read nullifier bytes from field indices 115..147
    const bytes: string[] = [];
    for (let i = 115; i < 147; i++) {
      const byte = (BigInt(fields[i]) & 0xFFn).toString(16).padStart(2, '0');
      bytes.push(byte);
    }

    return '0x' + bytes.join('');
  } catch {
    return null;
  }
}
