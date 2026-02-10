import { ethers } from 'ethers';
import { CIRCUITS, type CircuitId } from '../config/circuits.js';
import { AUTHORIZED_SIGNERS } from '../config/contracts.js';
import { SimpleMerkleTree } from './merkleTree.js';
import {
  fetchAttestationData,
  recoverAttesterPubkey,
  getSignerAddress,
  type AttestationTxData,
} from './attestationFetcher.js';

// ─── Constants ───────────────────────────────────────────────────────────

const RAW_TX_PADDED_LENGTH = 300;
const MERKLE_PROOF_MAX_DEPTH = 8;
const COUNTRY_LIST_MAX_LENGTH = 10;
const COUNTRY_CODE_BYTES = 2;

// Expected flat input vector lengths
const COINBASE_ATTESTATION_INPUT_LENGTH = 899;
const COINBASE_COUNTRY_ATTESTATION_INPUT_LENGTH = 921;

// ─── Utility functions ───────────────────────────────────────────────────

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
 * Pad a byte array to a target length with trailing zeros.
 */
export function padBytes(arr: number[], targetLength: number): number[] {
  const result = [...arr];
  while (result.length < targetLength) {
    result.push(0);
  }
  return result;
}

/**
 * Convert an array of byte values to DECIMAL string entries.
 * Each byte becomes a separate string: e.g., 149 -> "149", 2 -> "2"
 *
 * CRITICAL: This is the server format (DECIMAL). The mobile app uses hex ("0x95").
 */
export function bytesToDecimalStrings(bytes: number[]): string[] {
  return bytes.map(b => b.toString());
}

/**
 * Convert a Uint8Array to DECIMAL string entries.
 */
export function uint8ArrayToDecimalStrings(arr: Uint8Array): string[] {
  return Array.from(arr).map(b => b.toString());
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

// ─── Step 1: Compute signal_hash ─────────────────────────────────────────

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

// ─── Step 2: Recover user public key ─────────────────────────────────────

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

// ─── Step 5: Build Merkle tree ───────────────────────────────────────────

export interface MerkleData {
  root: string;
  proof: string[];
  leafIndex: number;
  depth: number;
}

/**
 * Build a Merkle tree from authorized signers and get proof for the given signer index.
 */
export function buildSignerMerkleTree(signerIndex: number): MerkleData {
  const tree = new SimpleMerkleTree(AUTHORIZED_SIGNERS);
  const root = tree.getRoot();
  const { proof, leafIndex, depth } = tree.getProof(signerIndex);

  return { root, proof, leafIndex, depth };
}

/**
 * Find the index of a signer address in the authorized signers list.
 */
export function findSignerIndex(signerAddress: string): number {
  const index = AUTHORIZED_SIGNERS.findIndex(
    addr => addr.toLowerCase() === signerAddress.toLowerCase(),
  );
  if (index === -1) {
    throw new Error(
      `Signer ${signerAddress} is not in the authorized signers list`
    );
  }
  return index;
}

// ─── Step 6: Compute scope and nullifier ─────────────────────────────────

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

// ─── Step 7: Assemble inputs ─────────────────────────────────────────────

/**
 * Encode a country list into the [[u8; 2]; 10] format.
 * Each country code is 2 ASCII bytes (e.g., "US" -> [85, 83]).
 * Pads to 10 entries with zero pairs.
 * Returns 20 decimal strings.
 */
export function encodeCountryList(countries: string[]): string[] {
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
 * Split a signature into r (32 bytes) + s (32 bytes) = 64 bytes.
 * Drops the v component.
 */
export function splitSignatureToBytes(signature: string): number[] {
  const sig = ethers.Signature.from(signature);
  const rBytes = hexToBytes(sig.r);
  const sBytes = hexToBytes(sig.s);
  return [...rBytes, ...sBytes];
}

/**
 * Build a padded Merkle proof: 8 * 32 = 256 bytes as decimal strings.
 */
export function buildPaddedMerkleProof(proof: string[], depth: number): string[] {
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

/**
 * Assemble the flat input vector for coinbase_attestation (879 entries).
 *
 * Order:
 *   signal_hash[32] ++ signer_list_merkle_root[32] ++ scope[32] ++ nullifier[32] ++
 *   user_address[20] ++ user_signature[64] ++ user_pubkey_x[32] ++ user_pubkey_y[32] ++
 *   raw_transaction[300] ++ tx_length[1] ++
 *   coinbase_attester_pubkey_x[32] ++ coinbase_attester_pubkey_y[32] ++
 *   coinbase_signer_merkle_proof[256] ++ coinbase_signer_leaf_index[1] ++ merkle_proof_depth[1]
 */
export function assembleKycInputs(params: {
  signalHash: Uint8Array;
  merkleRoot: string;
  scopeBytes: Uint8Array;
  nullifierBytes: Uint8Array;
  userAddress: string;
  userSignature: string;
  userPubkeyX: string;
  userPubkeyY: string;
  rawTxBytes: number[];
  txLength: number;
  attesterPubkeyX: string;
  attesterPubkeyY: string;
  merkleProof: string[];
  merkleLeafIndex: number;
  merkleDepth: number;
}): string[] {
  const inputs: string[] = [];

  // signal_hash[32]
  inputs.push(...uint8ArrayToDecimalStrings(params.signalHash));
  // signer_list_merkle_root[32]
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.merkleRoot)));
  // scope[32]
  inputs.push(...uint8ArrayToDecimalStrings(params.scopeBytes));
  // nullifier[32]
  inputs.push(...uint8ArrayToDecimalStrings(params.nullifierBytes));
  // user_address[20]
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.userAddress)));
  // user_signature[64] (r + s, no v)
  inputs.push(...bytesToDecimalStrings(splitSignatureToBytes(params.userSignature)));
  // user_pubkey_x[32]
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.userPubkeyX)));
  // user_pubkey_y[32]
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.userPubkeyY)));
  // raw_transaction[300] (padded)
  inputs.push(...bytesToDecimalStrings(padBytes(params.rawTxBytes, RAW_TX_PADDED_LENGTH)));
  // tx_length[1]
  inputs.push(params.txLength.toString());
  // coinbase_attester_pubkey_x[32]
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.attesterPubkeyX)));
  // coinbase_attester_pubkey_y[32]
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.attesterPubkeyY)));
  // coinbase_signer_merkle_proof[256] (8 * 32 bytes, padded)
  inputs.push(...buildPaddedMerkleProof(params.merkleProof, params.merkleDepth));
  // coinbase_signer_leaf_index[1]
  inputs.push(params.merkleLeafIndex.toString());
  // merkle_proof_depth[1]
  inputs.push(params.merkleDepth.toString());

  return inputs;
}

/**
 * Assemble the flat input vector for coinbase_country_attestation (901 entries).
 *
 * Order:
 *   signal_hash[32] ++ signer_list_merkle_root[32] ++
 *   country_list[20] ++ country_list_length[1] ++ is_included[1] ++  <-- BETWEEN merkle_root and scope
 *   scope[32] ++ nullifier[32] ++
 *   user_address[20] ++ user_signature[64] ++ user_pubkey_x[32] ++ user_pubkey_y[32] ++
 *   raw_transaction[300] ++ tx_length[1] ++
 *   coinbase_attester_pubkey_x[32] ++ coinbase_attester_pubkey_y[32] ++
 *   coinbase_signer_merkle_proof[256] ++ coinbase_signer_leaf_index[1] ++ merkle_proof_depth[1]
 */
export function assembleCountryInputs(params: {
  signalHash: Uint8Array;
  merkleRoot: string;
  countryList: string[];
  countryListLength: number;
  isIncluded: boolean;
  scopeBytes: Uint8Array;
  nullifierBytes: Uint8Array;
  userAddress: string;
  userSignature: string;
  userPubkeyX: string;
  userPubkeyY: string;
  rawTxBytes: number[];
  txLength: number;
  attesterPubkeyX: string;
  attesterPubkeyY: string;
  merkleProof: string[];
  merkleLeafIndex: number;
  merkleDepth: number;
}): string[] {
  const inputs: string[] = [];

  // signal_hash[32]
  inputs.push(...uint8ArrayToDecimalStrings(params.signalHash));
  // signer_list_merkle_root[32]
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.merkleRoot)));

  // --- Country fields BETWEEN merkle_root and scope ---
  // country_list[20] ([[u8; 2]; 10] padded)
  inputs.push(...encodeCountryList(params.countryList));
  // country_list_length[1]
  inputs.push(params.countryListLength.toString());
  // is_included[1]
  inputs.push(params.isIncluded ? '1' : '0');

  // scope[32]
  inputs.push(...uint8ArrayToDecimalStrings(params.scopeBytes));
  // nullifier[32]
  inputs.push(...uint8ArrayToDecimalStrings(params.nullifierBytes));
  // user_address[20]
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.userAddress)));
  // user_signature[64] (r + s, no v)
  inputs.push(...bytesToDecimalStrings(splitSignatureToBytes(params.userSignature)));
  // user_pubkey_x[32]
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.userPubkeyX)));
  // user_pubkey_y[32]
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.userPubkeyY)));
  // raw_transaction[300] (padded)
  inputs.push(...bytesToDecimalStrings(padBytes(params.rawTxBytes, RAW_TX_PADDED_LENGTH)));
  // tx_length[1]
  inputs.push(params.txLength.toString());
  // coinbase_attester_pubkey_x[32]
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.attesterPubkeyX)));
  // coinbase_attester_pubkey_y[32]
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.attesterPubkeyY)));
  // coinbase_signer_merkle_proof[256] (8 * 32 bytes, padded)
  inputs.push(...buildPaddedMerkleProof(params.merkleProof, params.merkleDepth));
  // coinbase_signer_leaf_index[1]
  inputs.push(params.merkleLeafIndex.toString());
  // merkle_proof_depth[1]
  inputs.push(params.merkleDepth.toString());

  return inputs;
}

// ─── Main pipeline ───────────────────────────────────────────────────────

export interface BuildInputsRequest {
  address: string;
  signature: string;
  scope: string;
  circuitId: CircuitId;
  countryList?: string[];
  isIncluded?: boolean;
}

export interface BuildInputsResult {
  inputs: string[];
  nullifier: string;
  signalHash: string;
}

/**
 * Intermediate structured circuit parameters before flattening to decimal array.
 * Contains all computed values needed for proof generation.
 */
export interface CircuitParams {
  signalHash: Uint8Array;
  merkleRoot: string;
  scopeBytes: Uint8Array;
  nullifierBytes: Uint8Array;
  userAddress: string;
  userSignature: string;
  userPubkeyX: string;
  userPubkeyY: string;
  rawTxBytes: number[];
  txLength: number;
  attesterPubkeyX: string;
  attesterPubkeyY: string;
  merkleProof: string[];
  merkleLeafIndex: number;
  merkleDepth: number;
  countryList?: string[];
  countryListLength?: number;
  isIncluded?: boolean;
}

/**
 * Compute all circuit parameters without flattening to decimal array.
 * Returns structured data that can be used for Prover.toml generation or flat input assembly.
 *
 * Steps performed:
 * 1. Validate circuit and country fields
 * 2. Compute signal hash
 * 3. Recover user public key
 * 4. Fetch attestation data from Base chain
 * 5. Recover attester public key and build Merkle tree
 * 6. Compute scope and nullifier
 * 7. Convert raw TX to bytes
 */
export async function computeCircuitParams(
  request: BuildInputsRequest,
  easGraphqlEndpoint: string,
  rpcUrls: string[],
): Promise<CircuitParams> {
  const { address, signature, scope, circuitId } = request;

  // Validate circuit
  if (!(circuitId in CIRCUITS)) {
    throw new Error(`Unknown circuit: ${circuitId}`);
  }

  // Validate country fields for country circuit
  if (circuitId === 'coinbase_country_attestation') {
    if (!request.countryList || request.countryList.length === 0) {
      throw new Error('countryList is required for coinbase_country_attestation');
    }
    if (request.isIncluded === undefined || request.isIncluded === null) {
      throw new Error('isIncluded is required for coinbase_country_attestation');
    }
  }

  // Step 1: Compute signal hash
  const signalHash = computeSignalHash(address, scope, circuitId);

  // Step 2: Recover user public key
  const userPubkey = recoverUserPubkey(signalHash, signature);
  const { x: userPubkeyX, y: userPubkeyY } = extractPubkeyCoordinates(userPubkey);

  // Step 3: Fetch attestation transaction from Base chain
  const attestationData = await fetchAttestationData(
    easGraphqlEndpoint,
    rpcUrls,
    circuitId,
    address,
  );

  // Step 4: Recover Coinbase attester public key
  const attesterPubkey = recoverAttesterPubkey(attestationData.rawTransaction);
  const attesterAddress = getSignerAddress(attesterPubkey);
  const { x: attesterPubkeyX, y: attesterPubkeyY } = extractPubkeyCoordinates(attesterPubkey);

  // Step 5: Build Merkle tree
  const signerIndex = findSignerIndex(attesterAddress);
  const merkleData = buildSignerMerkleTree(signerIndex);

  // Step 6: Compute scope and nullifier
  const scopeBytes = computeScope(scope);
  const nullifierBytes = computeNullifier(address, signalHash, scopeBytes);

  // Step 7: Convert raw TX to byte array
  const rawTxHex = attestationData.rawTransaction;
  const rawTxBytes = hexToBytes(rawTxHex);
  const txLength = rawTxBytes.length;

  return {
    signalHash,
    merkleRoot: merkleData.root,
    scopeBytes,
    nullifierBytes,
    userAddress: address,
    userSignature: signature,
    userPubkeyX,
    userPubkeyY,
    rawTxBytes,
    txLength,
    attesterPubkeyX,
    attesterPubkeyY,
    merkleProof: merkleData.proof,
    merkleLeafIndex: merkleData.leafIndex,
    merkleDepth: merkleData.depth,
    countryList: request.countryList,
    countryListLength: request.countryList?.length,
    isIncluded: request.isIncluded,
  };
}

/**
 * Build the complete input vector for a circuit proof.
 *
 * Given only (address, signature, scope, circuitId), fetches all remaining
 * data from Base chain and constructs the full flat Vec<String> in DECIMAL format.
 */
export async function buildCircuitInputs(
  request: BuildInputsRequest,
  easGraphqlEndpoint: string,
  rpcUrls: string[],
): Promise<BuildInputsResult> {
  const { circuitId } = request;

  // Compute all circuit parameters
  const params = await computeCircuitParams(request, easGraphqlEndpoint, rpcUrls);

  // Assemble flat input vector
  let inputs: string[];

  if (circuitId === 'coinbase_attestation') {
    inputs = assembleKycInputs(params);

    if (inputs.length !== COINBASE_ATTESTATION_INPUT_LENGTH) {
      throw new Error(
        `coinbase_attestation input vector has ${inputs.length} entries, expected ${COINBASE_ATTESTATION_INPUT_LENGTH}`
      );
    }
  } else if (circuitId === 'coinbase_country_attestation') {
    inputs = assembleCountryInputs({
      ...params,
      countryList: params.countryList!,
      countryListLength: params.countryListLength!,
      isIncluded: params.isIncluded!,
    });

    if (inputs.length !== COINBASE_COUNTRY_ATTESTATION_INPUT_LENGTH) {
      throw new Error(
        `coinbase_country_attestation input vector has ${inputs.length} entries, expected ${COINBASE_COUNTRY_ATTESTATION_INPUT_LENGTH}`
      );
    }
  } else {
    throw new Error(`Unsupported circuit: ${circuitId}`);
  }

  // Verify all entries are decimal strings
  for (let i = 0; i < inputs.length; i++) {
    if (!/^\d+$/.test(inputs[i])) {
      throw new Error(
        `Input at index ${i} is not a valid decimal string: "${inputs[i]}"`
      );
    }
  }

  return {
    inputs,
    nullifier: ethers.hexlify(params.nullifierBytes),
    signalHash: ethers.hexlify(params.signalHash),
  };
}
