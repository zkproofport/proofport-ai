import { ethers } from 'ethers';
import { CIRCUITS, type CircuitId } from '../config/circuits.js';
import { CIRCUIT_IDS } from '../config/circuitIds.js';
import { AUTHORIZED_SIGNERS, ATTESTATION_SOURCES } from '../config/contracts.js';
import { findGiwaAttestation } from './giwaAttestation.js';
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
// The KYC vector plus the two 32-byte EIP-712 hashes.
const ARC_ELIGIBILITY_INPUT_LENGTH = 899 + 64;

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
 * keccak256(0x19 0x01 ++ domainSeparator ++ actionHash) -- the EIP-712 digest.
 *
 * Matches `create_eip712_digest` in coinbase-libs/src/ethereum.nr byte for
 * byte. Verified against ethers' own TypedDataEncoder.hash, which is what the
 * wallet computes.
 */
export function eip712Digest(domainSeparator?: string, actionHash?: string): Uint8Array {
  if (!domainSeparator || !actionHash) {
    throw new Error(
      'arc_eligibility requires domainSeparator and actionHash. The caller signs ' +
      'an EIP-712 typed action; personal_sign over signal_hash is the ' +
      'coinbase_attestation flow.',
    );
  }
  return ethers.getBytes(
    ethers.keccak256(ethers.concat(['0x1901', domainSeparator, actionHash])),
  );
}

/**
 * Recover the signer's public key from the digest they actually signed.
 *
 * personal_sign wraps its argument in the EIP-191 prefix; a typed-data
 * signature is already over the final digest and must NOT be wrapped again.
 */
export function recoverUserPubkeyFromDigest(
  digest: Uint8Array,
  signature: string,
  circuitId: string,
): string {
  if (circuitId === CIRCUIT_IDS.ARC_ELIGIBILITY) {
    return ethers.SigningKey.recoverPublicKey(digest, signature);
  }
  return recoverUserPubkey(digest, signature);
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
export function buildSignerMerkleTree(
  signerIndex: number,
  signers: readonly string[],
): MerkleData {
  const tree = new SimpleMerkleTree([...signers]);
  const root = tree.getRoot();
  const { proof, leafIndex, depth } = tree.getProof(signerIndex);

  return { root, proof, leafIndex, depth };
}

/**
 * Find the index of a signer address in the authorized signers list.
 */
export function findSignerIndex(
  signerAddress: string,
  /*
   * Required, with no default. Defaulting to Coinbase's four signers meant a
   * caller that forgot to pass GIWA's single signer was told "not in the
   * authorized signers list" about an address that IS authorized, on the chain
   * the call was about.
   */
  signers: readonly string[],
): number {
  const index = signers.findIndex(
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
/**
 * The nullifier for a circuit whose secret material is the WALLET and a
 * constant compiled into that circuit -- not `signal_hash`.
 *
 * `arc_eligibility` and `giwa_attestation` derive it this way. They had to:
 * both branch on whether an action was supplied, and `signal_hash` is zero in
 * action mode, so a nullifier taken from it would differ between the two modes
 * for one wallet in one scope. It was already wrong before the branch --
 * nothing in those circuits constrains `signal_hash`, and in action mode
 * nobody signs it, so a prover could mint identities by varying bytes.
 *
 * MUST match `verify_wallet_nullifier` in coinbase-libs/src/nullifier.nr. If
 * the two disagree the proof fails with "Nullifier mismatch" and nothing
 * points here.
 */
export function computeWalletNullifier(
  userAddress: string,
  circuitId: string,
  scopeBytes: Uint8Array,
): Uint8Array {
  const circuitTag = ethers.getBytes(
    ethers.keccak256(ethers.toUtf8Bytes(circuitId)),
  );
  const userSecret = ethers.getBytes(
    ethers.keccak256(ethers.concat([ethers.getBytes(userAddress), circuitTag])),
  );
  return ethers.getBytes(
    ethers.keccak256(ethers.concat([userSecret, scopeBytes])),
  );
}

/**
 * Which nullifier formula a circuit uses. A table, because the answer differs
 * per circuit and the wrong one produces a proof that simply fails.
 */
const NULLIFIER_FROM_WALLET_AND_TAG: Readonly<Record<string, boolean>> = Object.freeze({
  coinbase_attestation: false,
  coinbase_country_attestation: false,
  arc_eligibility: true,
  giwa_attestation: true,
});

/** The nullifier this circuit expects, by its own rule. */
export function nullifierForCircuit(
  circuitId: string,
  userAddress: string,
  signalHash: Uint8Array,
  scopeBytes: Uint8Array,
): Uint8Array {
  const fromWallet = NULLIFIER_FROM_WALLET_AND_TAG[circuitId];
  if (fromWallet === undefined) {
    throw new Error(
      `No nullifier rule for circuit '${circuitId}'. Add it to NULLIFIER_FROM_WALLET_AND_TAG.`
    );
  }
  return fromWallet
    ? computeWalletNullifier(userAddress, circuitId, scopeBytes)
    : computeNullifier(userAddress, signalHash, scopeBytes);
}

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
/**
 * The `arc_eligibility` flat vector.
 *
 * Identical to the KYC one except that `domain_separator` and `action_hash`
 * sit between `signal_hash` and `signer_list_merkle_root`, which is the
 * parameter order in arc-eligibility/src/main.nr. bb reads this list
 * positionally, so a field in the wrong place makes a proof that fails to
 * verify with nothing naming the cause.
 */
const EMPTY_32 = new Array(32).fill(0);

export function assembleActionInputs(params: CircuitParams): string[] {
  /*
   * An action is OPTIONAL for both circuits that use this vector.
   *
   * It used to be required, because `arc_eligibility` had no second path: it
   * always verified an EIP-712 signature, so a request without an action built
   * a vector 64 bytes short and the prover died naming none of it. Both
   * circuits branch now -- with an action the wallet signs the typed data and
   * `signal_hash` must be empty; without one it personal_signs `signal_hash`
   * and the pair must be empty. The circuit refuses a vector that fills both.
   */
  const bound = Boolean(params.domainSeparator) && Boolean(params.actionHash);
  if (Boolean(params.domainSeparator) !== Boolean(params.actionHash)) {
    throw new Error(
      'Half an action: send both domainSeparator and actionHash, or neither. ' +
      `Got domainSeparator=${Boolean(params.domainSeparator)}, actionHash=${Boolean(params.actionHash)}.`
    );
  }
  const inputs: string[] = [];
  inputs.push(...(bound ? EMPTY_32.map(String) : uint8ArrayToDecimalStrings(params.signalHash)));
  inputs.push(...(bound ? bytesToDecimalStrings(hexToBytes(params.domainSeparator!)) : EMPTY_32.map(String)));
  inputs.push(...(bound ? bytesToDecimalStrings(hexToBytes(params.actionHash!)) : EMPTY_32.map(String)));
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.merkleRoot)));
  inputs.push(...uint8ArrayToDecimalStrings(params.scopeBytes));
  inputs.push(...uint8ArrayToDecimalStrings(params.nullifierBytes));
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.userAddress)));
  inputs.push(...bytesToDecimalStrings(splitSignatureToBytes(params.userSignature)));
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.userPubkeyX)));
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.userPubkeyY)));
  inputs.push(...bytesToDecimalStrings(padBytes(params.rawTxBytes, 300)));
  inputs.push(params.txLength.toString());
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.attesterPubkeyX)));
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.attesterPubkeyY)));
  inputs.push(...buildPaddedMerkleProof(params.merkleProof, params.merkleDepth));
  inputs.push(params.merkleLeafIndex.toString());
  inputs.push(params.merkleDepth.toString());
  return inputs;
}

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
  /**
   * EIP-712 domain hash. Required for `arc_eligibility`, absent otherwise.
   *
   * The server does NOT derive it: the domain names a verifying contract and a
   * chain that only the caller knows, and guessing one here would produce a
   * proof bound to the wrong contract.
   */
  domainSeparator?: string;
  /** EIP-712 hashStruct of the action. Required for `arc_eligibility`. */
  actionHash?: string;
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
  domainSeparator?: string;
  actionHash?: string;
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
  if (circuitId === CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION) {
    if (!request.countryList || request.countryList.length === 0) {
      throw new Error('countryList is required for coinbase_country_attestation');
    }
    if (request.isIncluded === undefined || request.isIncluded === null) {
      throw new Error('isIncluded is required for coinbase_country_attestation');
    }
  }

  // Step 1: Compute signal hash
  const signalHash = computeSignalHash(address, scope, circuitId);

  // Step 2: Recover user public key.
  //
  // From whatever the wallet actually signed. `arc_eligibility` has it sign an
  // EIP-712 digest over the action, not signal_hash, so recovering against
  // signal_hash there yields a public key that is not the user's -- and the
  // circuit then fails on "User pubkey does not match address", pointing at
  // the address rather than at the message.
  /*
   * What was signed follows the ACTION, not the circuit id. Arc and GIWA both
   * accept either; asking the circuit gave the wrong answer the moment the
   * action became optional, and recovering against the wrong digest yields a
   * well-formed key for a wallet nobody controls -- which the circuit reports
   * as "User pubkey does not match address", pointing at the address.
   */
  const hasAction = Boolean(request.domainSeparator) && Boolean(request.actionHash);
  const signedDigest = hasAction
    ? eip712Digest(request.domainSeparator, request.actionHash)
    : signalHash;
  const userPubkey = recoverUserPubkeyFromDigest(signedDigest, signature, circuitId);
  const { x: userPubkeyX, y: userPubkeyY } = extractPubkeyCoordinates(userPubkey);

  /*
   * Step 3: the attestation transaction, from whichever chain attests THIS
   * circuit. Coinbase's are indexed by EAS on Base; GIWA's come from our own
   * attester on GIWA Sepolia, which nothing indexes. Asking Base for a GIWA
   * wallet does not fail -- it answers "no attestation", which reads as an
   * unattested user.
   */
  const source = ATTESTATION_SOURCES[circuitId];
  if (!source) {
    throw new Error(
      `${circuitId} has no on-chain attestation source, so this pipeline cannot build its inputs.`
    );
  }

  let rawTransaction: string;
  if (source.kind === 'giwa-sepolia') {
    const explorerUrl = process.env.GIWA_EXPLORER_URL;
    const giwaRpcUrl = process.env.GIWA_RPC_URL;
    if (!explorerUrl || !giwaRpcUrl) {
      throw new Error(
        'GIWA_RPC_URL and GIWA_EXPLORER_URL are required to prove giwa_attestation'
      );
    }
    const found = await findGiwaAttestation(explorerUrl, giwaRpcUrl, address);
    if (!found) {
      throw new Error(`No GIWA attestation found for ${address}`);
    }
    rawTransaction = found.rawTransaction;
  } else {
    const attestationData = await fetchAttestationData(
      easGraphqlEndpoint,
      rpcUrls,
      circuitId,
      address,
    );
    rawTransaction = attestationData.rawTransaction;
  }

  // Step 4: Recover the attester's public key from that transaction
  const attesterPubkey = recoverAttesterPubkey(rawTransaction);
  const attesterAddress = getSignerAddress(attesterPubkey);
  const { x: attesterPubkeyX, y: attesterPubkeyY } = extractPubkeyCoordinates(attesterPubkey);

  // Step 5: Build the Merkle tree over THIS circuit's accepted signers
  const signerIndex = findSignerIndex(attesterAddress, source.signers);
  const merkleData = buildSignerMerkleTree(signerIndex, source.signers);

  // Step 6: Compute scope and nullifier
  const scopeBytes = computeScope(scope);
  const nullifierBytes = nullifierForCircuit(circuitId, address, signalHash, scopeBytes);

  // Step 7: Convert raw TX to byte array
  const rawTxHex = rawTransaction;
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
    domainSeparator: request.domainSeparator,
    actionHash: request.actionHash,
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

  if (circuitId === CIRCUIT_IDS.COINBASE_ATTESTATION) {
    inputs = assembleKycInputs(params);

    if (inputs.length !== COINBASE_ATTESTATION_INPUT_LENGTH) {
      throw new Error(
        `coinbase_attestation input vector has ${inputs.length} entries, expected ${COINBASE_ATTESTATION_INPUT_LENGTH}`
      );
    }
  } else if (circuitId === CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION) {
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
  } else if (
    circuitId === CIRCUIT_IDS.ARC_ELIGIBILITY ||
    circuitId === CIRCUIT_IDS.GIWA_ATTESTATION
  ) {
    // One vector for both: the two circuits take the same public inputs in the
    // same order, and both make the action optional.
    inputs = assembleActionInputs(params);

    if (inputs.length !== ARC_ELIGIBILITY_INPUT_LENGTH) {
      throw new Error(
        `${circuitId} input vector has ${inputs.length} entries, expected ${ARC_ELIGIBILITY_INPUT_LENGTH}`
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
