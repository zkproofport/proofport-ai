/**
 * Prover.toml builder for client-side E2E encryption.
 *
 * Converts SDK ProveInputs to Prover.toml string format that the TEE's
 * bb CLI can consume directly. This enables the client to build the complete
 * proverToml locally, encrypt it with the TEE's public key, and send the
 * encrypted blob — making the server a blind relay.
 */

import { ethers } from 'ethers';
import type { ProveInputs, CircuitId } from './types.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function hexToBytes(hex: string): number[] {
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

function bytesToHexArray(bytes: number[] | Uint8Array): string {
  const arr = Array.from(bytes);
  return '[' + arr.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ') + ']';
}

function splitSignature(sig: string): number[] {
  const signature = ethers.Signature.from(sig);
  const rBytes = hexToBytes(signature.r);
  // Use _s to get raw s value, bypassing canonical check
  const sValue = (signature as any)._s || signature.s;
  const sBytes = hexToBytes(sValue);
  return [...rBytes, ...sBytes];
}

function formatMerkleProof(proof: string[], maxDepth: number): string {
  const paddedProof: number[][] = [];
  for (let i = 0; i < maxDepth; i++) {
    if (i < proof.length) {
      paddedProof.push(padBytes(hexToBytes(proof[i]), 32));
    } else {
      paddedProof.push(new Array(32).fill(0));
    }
  }
  const lines = paddedProof.map(entry => '    ' + bytesToHexArray(entry));
  return '[\n' + lines.join(',\n') + '\n]';
}

function formatCountryList(countries: string[], maxEntries: number): string {
  const paddedList: number[][] = [];
  for (let i = 0; i < maxEntries; i++) {
    if (i < countries.length) {
      paddedList.push([countries[i].charCodeAt(0), countries[i].charCodeAt(1)]);
    } else {
      paddedList.push([0, 0]);
    }
  }
  const lines = paddedList.map(entry => '    ' + bytesToHexArray(entry));
  return '[\n' + lines.join(',\n') + '\n]';
}

// ─── Main Export ────────────────────────────────────────────────────────

/**
 * Build a Prover.toml string from SDK ProveInputs.
 *
 * This is the client-side equivalent of the server's toProverToml().
 * The output format must exactly match what the TEE's enclave-server.py expects.
 *
 * @param circuitId - Canonical circuit ID ('coinbase_attestation' or 'coinbase_country_attestation')
 * @param inputs - Client-computed ProveInputs from prepareInputs()
 * @returns Prover.toml content string
 */
export function buildProverToml(circuitId: CircuitId, inputs: ProveInputs): string {
  const lines: string[] = [];

  lines.push(`signal_hash = ${bytesToHexArray(hexToBytes(inputs.signal_hash))}`);
  lines.push(`signer_list_merkle_root = ${bytesToHexArray(hexToBytes(inputs.merkle_root))}`);

  if (circuitId === 'coinbase_country_attestation') {
    if (!inputs.country_list || inputs.is_included === undefined) {
      throw new Error('country_list and is_included are required for coinbase_country_attestation');
    }
    lines.push(`country_list = ${formatCountryList(inputs.country_list, 10)}`);
    lines.push(`country_list_length = ${inputs.country_list.length}`);
    lines.push(`is_included = ${inputs.is_included}`);
  }

  lines.push(`scope = ${bytesToHexArray(hexToBytes(inputs.scope_bytes))}`);
  lines.push(`nullifier = ${bytesToHexArray(hexToBytes(inputs.nullifier))}`);
  lines.push(`user_address = ${bytesToHexArray(hexToBytes(inputs.user_address))}`);
  lines.push(`user_signature = ${bytesToHexArray(splitSignature(inputs.signature))}`);
  lines.push(`user_pubkey_x = ${bytesToHexArray(hexToBytes(inputs.user_pubkey_x))}`);
  lines.push(`user_pubkey_y = ${bytesToHexArray(hexToBytes(inputs.user_pubkey_y))}`);
  lines.push(`tx_length = ${inputs.tx_length}`);
  lines.push(`raw_transaction = ${bytesToHexArray(padBytes(hexToBytes(inputs.raw_transaction), 300))}`);
  lines.push(`coinbase_attester_pubkey_x = ${bytesToHexArray(hexToBytes(inputs.coinbase_attester_pubkey_x))}`);
  lines.push(`coinbase_attester_pubkey_y = ${bytesToHexArray(hexToBytes(inputs.coinbase_attester_pubkey_y))}`);
  lines.push(`coinbase_signer_merkle_proof = ${formatMerkleProof(inputs.merkle_proof, 8)}`);
  lines.push(`coinbase_signer_leaf_index = ${inputs.leaf_index}`);
  lines.push(`merkle_proof_depth = ${inputs.depth}`);

  return lines.join('\n');
}
