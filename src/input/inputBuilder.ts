import { ethers } from 'ethers';
import { CIRCUITS, type CircuitId } from '../config/circuits.js';
import type { OprfCircuitInputs } from './oprfInputs.js';
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

// ─── Step 1: signal_hash ─────────────────────────────────────────────────
//
// Not computed here. signal_hash = keccak256(scope ++ circuitId ++ requestId),
// no wallet address, and its one implementation in this repository is
// `computeSignalHash` in packages/sdk/src/signalHash.ts (this tree's rootDir
// cannot import it). Callers pass the value in `BuildInputsRequest.signalHash`.

const SIGNAL_HASH_HEX = /^0x[0-9a-fA-F]{64}$/;

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
      'EIP-712 action signing requires both domainSeparator and actionHash. ' +
      'For an identity-only proof, omit the action and personal_sign the signal hash.',
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
  hasAction: boolean,
): string {
  if (hasAction) {
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

// ─── Main pipeline ───────────────────────────────────────────────────────

export interface BuildInputsRequest {
  address: string;
  signature: string;
  circuitId: CircuitId;
  /**
   * The request's signal_hash, 0x + 64 hex: all zeros with an action, else
   * `computeSignalHash({ scope, circuitId, requestId })` from
   * packages/sdk/src/signalHash.ts. The wallet signed it (without an action).
   */
  signalHash: string;
  countryList?: string[];
  isIncluded?: boolean;
  /**
   * EIP-712 domain hash. Optional for `giwa_attestation` (paired with
   * `actionHash`), absent otherwise.
   *
   * The server does NOT derive it: the domain names a verifying contract and a
   * chain that only the caller knows, and guessing one here would produce a
   * proof bound to the wrong contract.
   */
  domainSeparator?: string;
  /** EIP-712 hashStruct of the action. Optional for `giwa_attestation`. */
  actionHash?: string;
}

/**
 * Intermediate structured circuit parameters before flattening to decimal array.
 * Contains all computed values needed for proof generation.
 */
export interface CircuitParams {
  signalHash: Uint8Array;
  merkleRoot: string;
  /**
   * The OPRF nullifier inputs, as the SDK sent them and readOprfInputs
   * (./oprfInputs.ts) checked them before payment: oprf_key_hash, domain,
   * scope, nullifier (public) and the seven private values.
   */
  oprf: OprfCircuitInputs;
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
  /**
   * Coinbase v2 (KYC and Country) only: the revocation statement this server
   * signed with its Cloud KMS key (src/input/coinbaseStatement.ts). Required
   * there, refused everywhere else.
   */
  statement?: {
    clientData: Uint8Array;
    signature: Uint8Array;
    attestedAt: number;
  };
}

/**
 * Everything in {@link CircuitParams} that comes from the attestation and the
 * wallet's signature; the OPRF values come from the SDK and are added by the
 * caller.
 */
export type AttestationParams = Omit<CircuitParams, 'oprf'>;

/**
 * Compute the attestation part of the circuit parameters.
 * Used by the repository's scripts (gen-prover-toml, check-*-inputs); the
 * prove route builds CircuitParams from the SDK's inputs instead.
 *
 * Steps performed:
 * 1. Validate circuit and country fields
 * 2. Read the caller's signal hash
 * 3. Recover user public key
 * 4. Fetch attestation data from Base chain
 * 5. Recover attester public key and build Merkle tree
 * 6. (The OPRF nullifier inputs are not built here: the SDK computes them
 *    and the caller adds them as `oprf`.)
 * 7. Convert raw TX to bytes
 */
export async function computeCircuitParams(
  request: BuildInputsRequest,
  easGraphqlEndpoint: string,
  rpcUrls: string[],
): Promise<AttestationParams> {
  const { address, signature, circuitId } = request;

  // Validate circuit
  if (!(circuitId in CIRCUITS)) {
    throw new Error(`Unknown circuit: ${circuitId}. Known: ${Object.keys(CIRCUITS).join(', ')}.`);
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

  // Step 1: the caller's signal hash (see BuildInputsRequest.signalHash)
  if (typeof request.signalHash !== 'string' || !SIGNAL_HASH_HEX.test(request.signalHash)) {
    throw new Error('signalHash must be 0x followed by 64 hex characters (computeSignalHash in packages/sdk/src/signalHash.ts).');
  }
  const signalHash = ethers.getBytes(request.signalHash);

  // Step 2: Recover user public key.
  //
  /*
   * What was signed follows the ACTION, not the circuit id. GIWA accepts
   * either; asking the circuit gave the wrong answer the moment the
   * action became optional, and recovering against the wrong digest yields a
   * well-formed key for a wallet nobody controls -- which the circuit reports
   * as "User pubkey does not match address", pointing at the address.
   */
  const hasAction = Boolean(request.domainSeparator) && Boolean(request.actionHash);
  const signedDigest = hasAction
    ? eip712Digest(request.domainSeparator, request.actionHash)
    : signalHash;
  const userPubkey = recoverUserPubkeyFromDigest(signedDigest, signature, hasAction);
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


  // Step 7: Convert raw TX to byte array
  const rawTxHex = rawTransaction;
  const rawTxBytes = hexToBytes(rawTxHex);
  const txLength = rawTxBytes.length;

  return {
    signalHash,
    merkleRoot: merkleData.root,
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
