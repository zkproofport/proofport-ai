/**
 * inputFormatter.ts — Convert CircuitParams and OidcCircuitInputs to noir_js input format.
 *
 * noir_js expects a JS object where field names match the circuit's main() parameter names.
 * Values are hex strings ("0x...") for byte arrays, or string numbers for scalars.
 */

import type { CircuitParams } from '../input/inputBuilder.js';

// ─── OIDC Circuit Inputs ────────────────────────────────────────────────

export interface OidcCircuitInputs {
  // Public inputs
  pubkey_modulus_limbs: string[];   // 18 × u128 decimal strings
  domain: { storage: number[]; len: number };
  scope: number[];                  // 32 bytes
  nullifier: number[];              // 32 bytes
  provider: number;              // 0=Google, 1=Microsoft

  // Private inputs
  partial_data: { storage: number[]; len: number };
  partial_hash: number[];           // 8 × u32
  full_data_length: number;
  base64_decode_offset: number;
  redc_params_limbs: string[];      // 18 × u128 decimal strings
  signature_limbs: string[];        // 18 × u128 decimal strings
}

// ─── Helpers ────────────────────────────────────────────────────────────

function hexStringToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}

function padBytes(bytes: number[], length: number): number[] {
  const padded = [...bytes];
  while (padded.length < length) {
    padded.push(0);
  }
  return padded;
}

/**
 * Convert a byte array to the format noir_js expects for [u8; N]: array of hex strings.
 */
function toHexArray(bytes: number[] | Uint8Array): string[] {
  return Array.from(bytes).map(b => '0x' + b.toString(16).padStart(2, '0'));
}

/**
 * Split an Ethereum signature (65 bytes) into r(32) + s(32) = 64 bytes, dropping v.
 */
function splitSignature(sig: string): number[] {
  const clean = sig.startsWith('0x') ? sig.slice(2) : sig;
  const rHex = clean.slice(0, 64);
  const sHex = clean.slice(64, 128);
  return [...hexStringToBytes(rHex), ...hexStringToBytes(sHex)];
}

/**
 * Build padded Merkle proof as [[u8; 32]; 8] for noir_js.
 * Each entry is an array of 32 hex strings.
 */
function formatMerkleProofArray(proof: string[], maxDepth: number): string[][] {
  const result: string[][] = [];
  for (let i = 0; i < maxDepth; i++) {
    if (i < proof.length) {
      const bytes = hexStringToBytes(proof[i]);
      result.push(toHexArray(padBytes(bytes, 32)));
    } else {
      result.push(toHexArray(new Array(32).fill(0)));
    }
  }
  return result;
}

/**
 * Encode country list as [[u8; 2]; 10] for noir_js.
 * Each country code is 2 ASCII bytes padded to 10 entries.
 */
function formatCountryListArray(countries: string[], maxEntries: number): string[][] {
  const result: string[][] = [];
  for (let i = 0; i < maxEntries; i++) {
    if (i < countries.length) {
      const code = countries[i];
      result.push([
        '0x' + code.charCodeAt(0).toString(16).padStart(2, '0'),
        '0x' + code.charCodeAt(1).toString(16).padStart(2, '0'),
      ]);
    } else {
      result.push(['0x00', '0x00']);
    }
  }
  return result;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Convert CircuitParams to a noir_js-compatible input object for coinbase circuits.
 *
 * Field names match the circuit's main() parameter names exactly.
 */
export function formatCoinbaseInputs(
  circuitId: 'coinbase_attestation' | 'coinbase_country_attestation',
  params: CircuitParams,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};

  inputs.signal_hash = toHexArray(params.signalHash);
  inputs.signer_list_merkle_root = toHexArray(hexStringToBytes(params.merkleRoot));

  if (circuitId === 'coinbase_country_attestation') {
    if (!params.countryList || params.countryListLength === undefined || params.isIncluded === undefined) {
      throw new Error('countryList, countryListLength, and isIncluded are required for coinbase_country_attestation');
    }
    inputs.country_list = formatCountryListArray(params.countryList, 10);
    inputs.country_list_length = params.countryListLength.toString();
    inputs.is_included = params.isIncluded;
  }

  inputs.scope = toHexArray(params.scopeBytes);
  inputs.nullifier = toHexArray(params.nullifierBytes);
  inputs.user_address = toHexArray(hexStringToBytes(params.userAddress));
  inputs.user_signature = toHexArray(splitSignature(params.userSignature));
  inputs.user_pubkey_x = toHexArray(hexStringToBytes(params.userPubkeyX));
  inputs.user_pubkey_y = toHexArray(hexStringToBytes(params.userPubkeyY));
  inputs.raw_transaction = toHexArray(padBytes(params.rawTxBytes, 300));
  inputs.tx_length = params.txLength.toString();
  inputs.coinbase_attester_pubkey_x = toHexArray(hexStringToBytes(params.attesterPubkeyX));
  inputs.coinbase_attester_pubkey_y = toHexArray(hexStringToBytes(params.attesterPubkeyY));
  inputs.coinbase_signer_merkle_proof = formatMerkleProofArray(params.merkleProof, 8);
  inputs.coinbase_signer_leaf_index = params.merkleLeafIndex.toString();
  inputs.merkle_proof_depth = params.merkleDepth.toString();

  return inputs;
}

/**
 * Convert OidcCircuitInputs to a noir_js-compatible input object.
 *
 * Field names match the circuit's main() parameter names exactly.
 */
export function formatOidcInputs(inputs: OidcCircuitInputs): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Public inputs
  result.pubkey_modulus_limbs = inputs.pubkey_modulus_limbs;
  result.domain = {
    storage: toHexArray(inputs.domain.storage),
    len: inputs.domain.len.toString(),
  };
  result.scope = toHexArray(inputs.scope);
  result.nullifier = toHexArray(inputs.nullifier);
  result.provider = inputs.provider.toString();

  // Private inputs
  result.partial_data = {
    storage: toHexArray(inputs.partial_data.storage),
    len: inputs.partial_data.len.toString(),
  };
  result.partial_hash = inputs.partial_hash.map(v => (v >>> 0).toString());
  result.full_data_length = inputs.full_data_length.toString();
  result.base64_decode_offset = inputs.base64_decode_offset.toString();
  result.redc_params_limbs = inputs.redc_params_limbs;
  result.signature_limbs = inputs.signature_limbs;

  return result;
}
