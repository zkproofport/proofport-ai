import { ethers } from 'ethers';
import type { CircuitId, ProveInputs, ClientConfig } from './types.js';
import { CIRCUIT_NAME_MAP, type CircuitName } from './types.js';
import { CIRCUITS, RAW_TX_PADDED_LENGTH, MERKLE_PROOF_MAX_DEPTH, COUNTRY_LIST_MAX_LENGTH } from './constants.js';
import { fetchAttestation, recoverAttesterPubkey, getSignerAddress } from './attestation.js';
import { findSignerIndex, buildSignerMerkleTree } from './merkle.js';

// ─── Utility functions ──────────────────────────────────────────────────

/**
 * Convert a hex string to an array of byte values (numbers 0-255).
 */
export function hexToBytes(hex: string): number[] {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes: number[] = [];
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes.push(parseInt(cleanHex.slice(i, i + 2), 16));
  }
  return bytes;
}

/**
 * Extract X and Y coordinates from an uncompressed public key.
 * Input: "0x04..." (130 hex chars) or "04..." (128 hex chars)
 * Output: { x: "0x...", y: "0x..." } each 64 hex chars (32 bytes)
 */
export function extractPubkeyCoordinates(pubkey: string): { x: string; y: string } {
  const pubkeyHex = pubkey.startsWith('0x04') ? pubkey.slice(4) : pubkey.slice(2);
  const x = '0x' + pubkeyHex.slice(0, 64);
  const y = '0x' + pubkeyHex.slice(64, 128);
  return { x, y };
}

// ─── Core computation functions ─────────────────────────────────────────

/**
 * Compute the deterministic signal hash.
 * signalHash = keccak256(solidityPacked(address, scopeString, circuitName))
 */
export function computeSignalHash(
  userAddress: string,
  scopeString: string,
  circuitName: string,
): Uint8Array {
  const signalPreimage = ethers.solidityPacked(
    ['address', 'string', 'string'],
    [userAddress, scopeString, circuitName],
  );
  return ethers.getBytes(ethers.keccak256(signalPreimage));
}

/**
 * Recover user's uncompressed public key from their signature over the signal hash.
 * Returns "0x04..." (130 hex chars).
 */
export function recoverUserPubkey(
  signalHash: Uint8Array,
  userSignature: string,
): string {
  const messageHex = ethers.hexlify(signalHash);
  const ethSignedHash = ethers.hashMessage(ethers.getBytes(messageHex));
  const pubkey = ethers.SigningKey.recoverPublicKey(ethSignedHash, userSignature);
  return pubkey;
}

/**
 * Compute scope bytes from a scope string.
 * scope = keccak256(toUtf8Bytes(scopeString))
 */
export function computeScope(scopeString: string): Uint8Array {
  return ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(scopeString)));
}

/**
 * Compute nullifier = keccak256(keccak256(address + signalHash) + scope)
 */
export function computeNullifier(
  userAddress: string,
  signalHash: Uint8Array,
  scopeBytes: Uint8Array,
): Uint8Array {
  const userAddressBytes = ethers.getBytes(userAddress);
  const userSecret = ethers.getBytes(
    ethers.keccak256(ethers.concat([userAddressBytes, signalHash])),
  );
  return ethers.getBytes(
    ethers.keccak256(ethers.concat([userSecret, scopeBytes])),
  );
}

// ─── Internal helpers for input assembly ────────────────────────────────

/**
 * Pad a byte array to a target length with trailing zeros.
 */
function padBytes(arr: number[], targetLength: number): number[] {
  const result = [...arr];
  while (result.length < targetLength) {
    result.push(0);
  }
  return result;
}

/**
 * Split a signature into r (32 bytes) + s (32 bytes) = 64 bytes.
 * Drops the v component.
 */
function splitSignatureToBytes(signature: string): number[] {
  const sig = ethers.Signature.from(signature);
  const rBytes = hexToBytes(sig.r);
  const sBytes = hexToBytes(sig.s);
  return [...rBytes, ...sBytes];
}

/**
 * Encode a country list into the [[u8; 2]; 10] format.
 * Each country code is 2 ASCII bytes (e.g., "US" -> [85, 83]).
 * Pads to 10 entries with zero pairs.
 */
function encodeCountryList(countries: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < COUNTRY_LIST_MAX_LENGTH; i++) {
    if (i < countries.length) {
      result.push(countries[i].charCodeAt(0).toString());
      result.push(countries[i].charCodeAt(1).toString());
    } else {
      result.push('0');
      result.push('0');
    }
  }
  return result;
}

/**
 * Convert byte values to decimal string entries.
 */
function bytesToDecimalStrings(bytes: number[]): string[] {
  return bytes.map(b => b.toString());
}

/**
 * Convert a Uint8Array to decimal string entries.
 */
function uint8ArrayToDecimalStrings(arr: Uint8Array): string[] {
  return Array.from(arr).map(b => b.toString());
}

/**
 * Build a padded Merkle proof: 8 * 32 = 256 bytes as decimal strings.
 */
function buildPaddedMerkleProof(proof: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < MERKLE_PROOF_MAX_DEPTH; i++) {
    if (i < proof.length) {
      result.push(...bytesToDecimalStrings(hexToBytes(proof[i])));
    } else {
      result.push(...bytesToDecimalStrings(new Array(32).fill(0)));
    }
  }
  return result;
}

// ─── Main function ──────────────────────────────────────────────────────

/**
 * Prepare all inputs for POST /prove.
 *
 * Steps:
 * 1. Compute signal hash
 * 2. Recover user public key from signature
 * 3. Fetch EAS attestation + raw transaction from Base chain
 * 4. Recover Coinbase attester public key from tx signature
 * 5. Build authorized signer Merkle tree + proof
 * 6. Compute scope bytes and nullifier
 * 7. Assemble the ProveInputs object
 *
 * All hex string fields use "0x..." format. The server converts to decimal internally.
 */
export async function prepareInputs(config: ClientConfig, params: {
  circuitId: CircuitId;
  userAddress: string;
  userSignature: string;
  scope: string;
  countryList?: string[];
  isIncluded?: boolean;
}): Promise<ProveInputs> {
  const { circuitId, userAddress, userSignature, scope } = params;

  // Validate circuit
  if (!(circuitId in CIRCUITS)) {
    throw new Error(`Unknown circuit: ${circuitId}`);
  }

  // Validate country fields for country circuit
  if (circuitId === 'coinbase_country_attestation') {
    if (!params.countryList || params.countryList.length === 0) {
      throw new Error('countryList is required for coinbase_country_attestation');
    }
    if (params.isIncluded === undefined || params.isIncluded === null) {
      throw new Error('isIncluded is required for coinbase_country_attestation');
    }
  }

  // Step 1: Compute signal hash
  const signalHash = computeSignalHash(userAddress, scope, circuitId);

  // Step 2: Recover user public key
  const userPubkey = recoverUserPubkey(signalHash, userSignature);
  const { x: userPubkeyX, y: userPubkeyY } = extractPubkeyCoordinates(userPubkey);

  // Step 3: Fetch attestation transaction from Base chain
  const attestationData = await fetchAttestation(config, circuitId, userAddress);

  // Step 4: Recover Coinbase attester public key
  const attesterPubkey = recoverAttesterPubkey(attestationData.rawTransaction);
  const attesterAddress = getSignerAddress(attesterPubkey);
  const { x: attesterPubkeyX, y: attesterPubkeyY } = extractPubkeyCoordinates(attesterPubkey);

  // Step 5: Build Merkle tree
  const signerIndex = findSignerIndex(attesterAddress);
  const merkleData = buildSignerMerkleTree(signerIndex);

  // Step 6: Compute scope and nullifier
  const scopeBytes = computeScope(scope);
  const nullifierBytes = computeNullifier(userAddress, signalHash, scopeBytes);

  // Step 7: Convert raw TX to byte array
  const rawTxBytes = hexToBytes(attestationData.rawTransaction);
  const txLength = rawTxBytes.length;

  // Assemble ProveInputs -- all values as hex strings (0x...)
  const inputs: ProveInputs = {
    signal_hash: ethers.hexlify(signalHash),
    nullifier: ethers.hexlify(nullifierBytes),
    scope_bytes: ethers.hexlify(scopeBytes),
    merkle_root: merkleData.root,
    user_address: userAddress,
    signature: userSignature,
    user_pubkey_x: userPubkeyX,
    user_pubkey_y: userPubkeyY,
    raw_transaction: attestationData.rawTransaction,
    tx_length: txLength,
    coinbase_attester_pubkey_x: attesterPubkeyX,
    coinbase_attester_pubkey_y: attesterPubkeyY,
    merkle_proof: merkleData.proof,
    leaf_index: merkleData.leafIndex,
    depth: merkleData.depth,
  };

  // Add country-specific fields
  if (circuitId === 'coinbase_country_attestation') {
    inputs.country_list = params.countryList;
    inputs.is_included = params.isIncluded;
  }

  return inputs;
}
