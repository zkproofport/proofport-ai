import { ethers } from 'ethers';
import type { CircuitId, ProveInputs, ClientConfig } from './types.js';
import { CIRCUIT_NAME_MAP, type CircuitName, type HumanPassportProveInputs } from './types.js';
import { humanPassportChain, humanPassportScoreUnits } from '@zkproofport-app/core/circuits';
import { CIRCUIT_IDS, PROVABLE_CIRCUIT_IDS, circuitBindsAction } from './circuits.js';
import {
  CIRCUITS,
  RAW_TX_PADDED_LENGTH,
  MERKLE_PROOF_MAX_DEPTH,
  COUNTRY_LIST_MAX_LENGTH,
  attestationSource,
} from './constants.js';
import { fetchAttestation, recoverAttesterPubkey, getSignerAddress } from './attestation.js';
import { computeSignalHash } from './signalHash.js';
import { findSignerIndex, buildSignerMerkleTree } from './merkle.js';
import { checkPreparedOprf, type PreparedOprf } from './oprf/index.js';

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

/*
 * The nullifier is the OPRF's (./oprf/index.ts): one per wallet per
 * (oprfDomain, scope) under the network's key. The keccak nullifiers that
 * stood here (computeScope, computeNullifier, computeWalletNullifier,
 * nullifierForCircuit) are gone with the circuits that used them.
 */

/**
 * The signal_hash a request carries: all zeros when an EIP-712 action is bound
 * (the wallet signs the action, and the circuit refuses both), otherwise
 * {@link computeSignalHash} of the request id, which is then required.
 */
export function requestSignalHash(
  circuitId: CircuitId,
  scope: string,
  requestId: string | undefined,
  isAction: boolean,
): Uint8Array {
  if (isAction) return new Uint8Array(32);
  if (requestId === undefined) {
    throw new Error(
      `requestId is required for a ${circuitId} proof without an action: the wallet signs ` +
      'keccak256(scope ++ circuitId ++ requestId).',
    );
  }
  return computeSignalHash({ scope, circuitId, requestId });
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
 * 1. Compute signal hash (zeros with an action; else from scope, circuit and requestId)
 * 2. Recover user public key from signature
 * 3. Fetch EAS attestation + raw transaction from Base chain
 * 4. Recover Coinbase attester public key from tx signature
 * 5. Build authorized signer Merkle tree + proof
 * 6. Check the OPRF nullifier inputs (prepareOprf) for this circuit, wallet and scope
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
  /**
   * The EIP-712 hashes the wallet signed over, for `giwa_attestation` with an
   * action.
   *
   * Required then, because the wallet signs a typed action rather than
   * `signal_hash` — recovering against `signal_hash` yields a public key
   * that is not the user's, and the circuit then fails on "User pubkey does not
   * match address", which points at the address rather than at the message.
   * Added after exactly that failure on 2026-09-12: the caller was attaching
   * these two AFTER this function had already recovered the key.
   */
  domainSeparator?: string;
  actionHash?: string;
  /**
   * The id of the request this proof answers; required without an action.
   * signal_hash = keccak256(scope ++ circuitId ++ requestId) -- no wallet.
   */
  requestId?: string;
  /** The OPRF evaluation for this circuit, wallet and scope (prepareOprf). Required. */
  oprf: PreparedOprf;
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
    if (params.countryList.length > COUNTRY_LIST_MAX_LENGTH) {
      throw new Error(`countryList has ${params.countryList.length} codes; the circuit takes at most ${COUNTRY_LIST_MAX_LENGTH}`);
    }
    // The circuit compares two bytes with the attested country, so "kr" or
    // "KOR" would never match: refuse before anything is signed or paid.
    const badCode = params.countryList.find(c => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c));
    if (badCode !== undefined) {
      throw new Error(`countryList entry ${JSON.stringify(badCode)} is not an ISO 3166-1 alpha-2 code (two letters A-Z)`);
    }
  }

  /*
   * Whether this circuit can carry an action: core's table, the one every
   * layer reads (giwa_attestation and both Coinbase v2 circuits, optionally).
   */
  const canBindAction = circuitBindsAction(circuitId);
  const isAction = Boolean(params.domainSeparator) && Boolean(params.actionHash);

  if (!canBindAction && (params.domainSeparator || params.actionHash)) {
    throw new Error(
      `An EIP-712 action was given but '${circuitId}' has no inputs for one. ` +
      `Circuits that do: ${PROVABLE_CIRCUIT_IDS.filter(circuitBindsAction).join(', ')}.`,
    );
  }
  if (Boolean(params.domainSeparator) !== Boolean(params.actionHash)) {
    throw new Error(
      'Half an action: pass both domainSeparator and actionHash, or neither. ' +
      'The circuit refuses a request that fills one side, and a public key ' +
      'recovered against the wrong digest belongs to nobody.',
    );
  }
  // Step 1: the request's signal_hash (zeros with an action).
  const signalHash = requestSignalHash(circuitId, scope, params.requestId, isAction);

  // Step 2: Recover the user's public key from the digest they actually signed.
  const userPubkey = isAction
    ? ethers.SigningKey.recoverPublicKey(
        ethers.keccak256(ethers.concat(['0x1901', params.domainSeparator!, params.actionHash!])),
        userSignature,
      )
    : recoverUserPubkey(signalHash, userSignature);
  const { x: userPubkeyX, y: userPubkeyY } = extractPubkeyCoordinates(userPubkey);

  // Step 3: Fetch attestation transaction from Base chain
  const attestationData = await fetchAttestation(config, circuitId, userAddress);

  // Step 4: Recover Coinbase attester public key
  const attesterPubkey = recoverAttesterPubkey(attestationData.rawTransaction);
  const attesterAddress = getSignerAddress(attesterPubkey);
  const { x: attesterPubkeyX, y: attesterPubkeyY } = extractPubkeyCoordinates(attesterPubkey);

  // Step 5: Build Merkle tree over the signers THIS circuit accepts.
  const { signers } = attestationSource(circuitId);
  const signerIndex = findSignerIndex(attesterAddress, signers);
  const merkleData = buildSignerMerkleTree(signerIndex, signers);

  // Step 6: the OPRF nullifier inputs, re-verified for this circuit, wallet and scope
  const oprf = checkPreparedOprf(params.oprf, { circuitId, address: userAddress, scope });

  // Step 7: Convert raw TX to byte array
  const rawTxBytes = hexToBytes(attestationData.rawTransaction);
  const txLength = rawTxBytes.length;

  // Assemble ProveInputs -- all values as hex strings (0x...)
  const inputs: ProveInputs = {
    signal_hash: ethers.hexlify(signalHash),
    ...oprf,
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

/**
 * Prepare the inputs for `human_passport_score`. No network: the client sends
 * its signed request and the threshold, and the server finds the wallet's
 * Human Passport score on Base itself (and refuses, before payment, a wallet
 * without one or below the threshold).
 *
 * `minScore` is in Passport points (20 = 20.0): above 0, at most four
 * decimals; anything else is refused here, before a signature is spent.
 */
export function prepareHumanPassportInputs(params: {
  userAddress: string;
  userSignature: string;
  scope: string;
  minScore: unknown;
  chain: unknown;
  domainSeparator?: string;
  actionHash?: string;
  /** The id of the request this proof answers; required without an action. */
  requestId?: string;
  /** The OPRF evaluation for human_passport_score, this wallet and scope (prepareOprf). Required. */
  oprf: PreparedOprf;
}): HumanPassportProveInputs {
  const circuitId = CIRCUIT_IDS.HUMAN_PASSPORT_SCORE;
  try {
    humanPassportScoreUnits(params.minScore);
  } catch (e) {
    throw new Error(`minScore for human_passport: ${(e as Error).message}`);
  }
  try {
    humanPassportChain(params.chain);
  } catch (e) {
    throw new Error(`chain for human_passport: ${(e as Error).message}`);
  }
  if (Boolean(params.domainSeparator) !== Boolean(params.actionHash)) {
    throw new Error('Half an action: pass both domainSeparator and actionHash, or neither.');
  }
  const isAction = Boolean(params.domainSeparator) && Boolean(params.actionHash);
  const userAddress = ethers.getAddress(params.userAddress);
  const signalHash = requestSignalHash(circuitId, params.scope, params.requestId, isAction);
  const userPubkey = isAction
    ? ethers.SigningKey.recoverPublicKey(
        ethers.keccak256(ethers.concat(['0x1901', params.domainSeparator!, params.actionHash!])),
        params.userSignature,
      )
    : recoverUserPubkey(signalHash, params.userSignature);
  if (ethers.computeAddress(userPubkey) !== userAddress) {
    throw new Error(`The signature was not made by ${userAddress}; the circuit would refuse the proof.`);
  }
  const { x, y } = extractPubkeyCoordinates(userPubkey);
  const oprf = checkPreparedOprf(params.oprf, { circuitId, address: userAddress, scope: params.scope });
  return {
    signal_hash: ethers.hexlify(signalHash),
    ...(isAction ? { domain_separator: params.domainSeparator, action_hash: params.actionHash } : {}),
    ...oprf,
    user_address: userAddress,
    signature: params.userSignature,
    user_pubkey_x: x,
    user_pubkey_y: y,
    min_score: params.minScore as number,
    chain: params.chain as number,
  };
}
