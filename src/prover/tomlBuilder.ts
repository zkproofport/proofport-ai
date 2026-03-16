import type { CircuitParams } from '../input/inputBuilder.js';

export type { CircuitParams };

// ─── OIDC Circuit Inputs ────────────────────────────────────────────────

export interface OidcCircuitInputs {
  // Public inputs
  pubkey_modulus_limbs: string[];   // 18 × u128 decimal strings
  domain: { storage: number[]; len: number };
  scope: number[];                  // 32 bytes
  nullifier: number[];              // 32 bytes

  // Private inputs
  partial_data: { storage: number[]; len: number };
  partial_hash: number[];           // 8 × u32
  full_data_length: number;
  base64_decode_offset: number;
  redc_params_limbs: string[];      // 18 × u128 decimal strings
  signature_limbs: string[];        // 18 × u128 decimal strings
}

function bytesToHexArray(bytes: number[] | Uint8Array): string {
  const arr = Array.from(bytes);
  return '[' + arr.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ') + ']';
}

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

function splitSignature(sig: string): number[] {
  // Ethereum signature: 65 bytes = r(32) + s(32) + v(1)
  const clean = sig.startsWith('0x') ? sig.slice(2) : sig;
  const rHex = clean.slice(0, 64);
  const sHex = clean.slice(64, 128);
  return [...hexStringToBytes(rHex), ...hexStringToBytes(sHex)];
}

function formatMerkleProof(proof: string[], maxDepth: number): string {
  const paddedProof: number[][] = [];

  for (let i = 0; i < maxDepth; i++) {
    if (i < proof.length) {
      const bytes = hexStringToBytes(proof[i]);
      paddedProof.push(padBytes(bytes, 32));
    } else {
      paddedProof.push(new Array(32).fill(0));
    }
  }

  const lines = paddedProof.map(entry => {
    return '    ' + bytesToHexArray(entry);
  });

  return '[\n' + lines.join(',\n') + '\n]';
}

function formatCountryList(countries: string[], maxEntries: number): string {
  const paddedList: number[][] = [];

  for (let i = 0; i < maxEntries; i++) {
    if (i < countries.length) {
      const code = countries[i];
      const bytes = [code.charCodeAt(0), code.charCodeAt(1)];
      paddedList.push(bytes);
    } else {
      paddedList.push([0, 0]);
    }
  }

  const lines = paddedList.map(entry => {
    return '    ' + bytesToHexArray(entry);
  });

  return '[\n' + lines.join(',\n') + '\n]';
}

export function toProverToml(
  circuitId: 'coinbase_attestation' | 'coinbase_country_attestation',
  params: CircuitParams
): string {
  const p = params;
  const lines: string[] = [];

  lines.push(`signal_hash = ${bytesToHexArray(p.signalHash)}`);
  lines.push(`signer_list_merkle_root = ${bytesToHexArray(hexStringToBytes(p.merkleRoot))}`);

  if (circuitId === 'coinbase_country_attestation') {
    if (!p.countryList || p.countryListLength === undefined || p.isIncluded === undefined) {
      throw new Error('countryList, countryListLength, and isIncluded are required for coinbase_country_attestation');
    }
    lines.push(`country_list = ${formatCountryList(p.countryList, 10)}`);
    lines.push(`country_list_length = ${p.countryListLength}`);
    lines.push(`is_included = ${p.isIncluded}`);
  }

  lines.push(`scope = ${bytesToHexArray(p.scopeBytes)}`);
  lines.push(`nullifier = ${bytesToHexArray(p.nullifierBytes)}`);
  lines.push(`user_address = ${bytesToHexArray(hexStringToBytes(p.userAddress))}`);
  lines.push(`user_signature = ${bytesToHexArray(splitSignature(p.userSignature))}`);
  lines.push(`user_pubkey_x = ${bytesToHexArray(hexStringToBytes(p.userPubkeyX))}`);
  lines.push(`user_pubkey_y = ${bytesToHexArray(hexStringToBytes(p.userPubkeyY))}`);
  lines.push(`tx_length = ${p.txLength}`);
  lines.push(`raw_transaction = ${bytesToHexArray(padBytes(p.rawTxBytes, 300))}`);
  lines.push(`coinbase_attester_pubkey_x = ${bytesToHexArray(hexStringToBytes(p.attesterPubkeyX))}`);
  lines.push(`coinbase_attester_pubkey_y = ${bytesToHexArray(hexStringToBytes(p.attesterPubkeyY))}`);
  lines.push(`coinbase_signer_merkle_proof = ${formatMerkleProof(p.merkleProof, 8)}`);
  lines.push(`coinbase_signer_leaf_index = ${p.merkleLeafIndex}`);
  lines.push(`merkle_proof_depth = ${p.merkleDepth}`);

  return lines.join('\n');
}

// ─── OIDC Prover.toml helpers ───────────────────────────────────────────

function toHexArray(bytes: number[]): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    lines.push('    ' + chunk.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', '));
  }
  return '[\n' + lines.join(',\n') + '\n]';
}

function toDecimalArray(values: string[]): string {
  return '[\n' + values.map((v, i) => {
    const comma = i < values.length - 1 ? ',' : '';
    return `    "${v}"${comma}`;
  }).join('\n') + '\n]';
}

function toU32Array(values: number[]): string {
  return '[\n' + values.map((v, i) => {
    const comma = i < values.length - 1 ? ',' : '';
    return `    ${v >>> 0}${comma}`;
  }).join('\n') + '\n]';
}

/**
 * Build a Prover.toml string from OidcCircuitInputs.
 * Ported from packages/sdk/src/oidc-inputs.ts buildOidcProverToml().
 */
export function toOidcProverToml(inputs: OidcCircuitInputs): string {
  const lines: string[] = [];

  lines.push('# Public Inputs');
  lines.push(`pubkey_modulus_limbs = ${toDecimalArray(inputs.pubkey_modulus_limbs)}`);
  lines.push(`scope = ${toHexArray(inputs.scope)}`);
  lines.push(`nullifier = ${toHexArray(inputs.nullifier)}`);
  lines.push('');
  lines.push('# Private Inputs');
  lines.push(`partial_hash = ${toU32Array(inputs.partial_hash)}`);
  lines.push(`full_data_length = ${inputs.full_data_length}`);
  lines.push(`base64_decode_offset = ${inputs.base64_decode_offset}`);
  lines.push(`redc_params_limbs = ${toDecimalArray(inputs.redc_params_limbs)}`);
  lines.push(`signature_limbs = ${toDecimalArray(inputs.signature_limbs)}`);
  lines.push('');
  lines.push('# BoundedVec tables (must be last in TOML)');
  lines.push('[domain]');
  lines.push(`storage = ${toHexArray(inputs.domain.storage)}`);
  lines.push(`len = ${inputs.domain.len}`);
  lines.push('');
  lines.push('[partial_data]');
  lines.push(`storage = ${toHexArray(inputs.partial_data.storage)}`);
  lines.push(`len = ${inputs.partial_data.len}`);

  return lines.join('\n') + '\n';
}
