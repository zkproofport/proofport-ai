import { ethers } from 'ethers';
import type { CircuitParams } from '../input/inputBuilder.js';
import { buildOidcProverToml, type OidcCircuitInputs } from '../oidc/inputs.js';

export type { CircuitParams };

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
  const signature = ethers.Signature.from(sig);
  const rBytes = hexStringToBytes(signature.r);
  // Use _s to get raw s value, bypassing canonical check
  const sValue = (signature as any)._s || signature.s;
  const sBytes = hexStringToBytes(sValue);
  return [...rBytes, ...sBytes];
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
  circuitId: 'coinbase_attestation' | 'coinbase_country_attestation' | 'oidc_domain_attestation',
  params: CircuitParams | OidcCircuitInputs
): string {
  if (circuitId === 'oidc_domain_attestation') {
    return buildOidcProverToml(params as unknown as OidcCircuitInputs);
  }

  const p = params as CircuitParams;
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
