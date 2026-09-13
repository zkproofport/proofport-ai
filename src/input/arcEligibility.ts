/**
 * Inputs for the `arc_eligibility` circuit.
 *
 * One thing differs from `buildProofInputs` in inputBuilder.ts: what the user
 * signs. Everything else is imported from there rather than copied, and the
 * nullifier is derived exactly as on Base.
 *
 * The existing circuit has the user sign `signal_hash` =
 * keccak256(address, scopeString, circuitName), through personal_sign. That
 * value is the same for a given wallet and scope no matter what the proof is
 * later used for, so it commits to no contract, amount, caller, ordering or
 * deadline -- and the wallet, handed 32 opaque bytes, can only show the person
 * a hex string to approve.
 *
 * Here the user signs an EIP-712 typed structure. The wallet renders the named
 * fields, and the domain separator binds the signature to one contract on one
 * chain. The two 32-byte results go to the circuit; the fields themselves do
 * not, so the circuit stays generic and the verifier recomputes both values
 * from what it is about to execute.
 *
 * `signal_hash` is still computed and still a public input, because the
 * nullifier derives from it. Deriving it from the signed action instead would
 * produce a different nullifier per action and destroy the one-per-person
 * property the nullifier exists for.
 */
import { ethers } from 'ethers';
import {
  bytesToDecimalStrings,
  hexToBytes,
  padBytes,
  buildPaddedMerkleProof,
  splitSignatureToBytes,
} from './inputBuilder.js';

/** An EIP-712 domain. The caller defines it; nothing here is our vocabulary. */
export interface TypedDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

/**
 * The typed structure the user signs, exactly as `eth_signTypedData_v4` takes
 * it. `types` must NOT include the EIP712Domain entry -- ethers adds it, and
 * passing it produces a different hash than the wallet computes.
 */
export interface TypedAction {
  domain: TypedDomain;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** hashStruct of the domain: what binds a signature to one contract and chain. */
export function computeDomainSeparator(domain: TypedDomain): Uint8Array {
  return ethers.getBytes(ethers.TypedDataEncoder.hashDomain(domain));
}

/** hashStruct of the action itself. */
export function computeActionHash(action: TypedAction): Uint8Array {
  return ethers.getBytes(
    ethers.TypedDataEncoder.hashStruct(action.primaryType, action.types, action.message),
  );
}

/**
 * The digest the wallet signs: keccak256(0x19 0x01 ++ domain ++ action).
 *
 * Provided so a caller can check what a wallet returned without re-deriving
 * the encoding by hand, and so the circuit's `create_eip712_digest` has
 * something to be tested against.
 */
export function computeTypedDigest(action: TypedAction): Uint8Array {
  return ethers.getBytes(
    ethers.TypedDataEncoder.hash(action.domain, action.types, action.message),
  );
}

export interface ArcEligibilityParams {
  signalHash: Uint8Array;
  domainSeparator: Uint8Array;
  actionHash: Uint8Array;
  merkleRoot: string;
  scope: Uint8Array;
  nullifier: Uint8Array;
  userAddress: string;
  userSignature: string;
  userPubkeyX: string;
  userPubkeyY: string;
  rawTransaction: string;
  txLength: number;
  attesterPubkeyX: string;
  attesterPubkeyY: string;
  merkleProof: string[];
  merkleLeafIndex: number;
  merkleDepth: number;
}

/**
 * The flat input list, in the circuit's parameter order.
 *
 * The order is load-bearing: bb takes a positional list, so a field in the
 * wrong place produces a proof that fails to verify with nothing pointing at
 * the cause. It matches circuits/arc-eligibility/src/main.nr exactly.
 */
export function buildArcEligibilityInputs(params: ArcEligibilityParams): string[] {
  const inputs: string[] = [];
  inputs.push(...bytesToDecimalStrings(Array.from(params.signalHash)));
  inputs.push(...bytesToDecimalStrings(Array.from(params.domainSeparator)));
  inputs.push(...bytesToDecimalStrings(Array.from(params.actionHash)));
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.merkleRoot)));
  inputs.push(...bytesToDecimalStrings(Array.from(params.scope)));
  inputs.push(...bytesToDecimalStrings(Array.from(params.nullifier)));
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.userAddress)));
  inputs.push(...bytesToDecimalStrings(splitSignatureToBytes(params.userSignature)));
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.userPubkeyX)));
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.userPubkeyY)));
  inputs.push(...bytesToDecimalStrings(padBytes(hexToBytes(params.rawTransaction), 300)));
  inputs.push(params.txLength.toString());
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.attesterPubkeyX)));
  inputs.push(...bytesToDecimalStrings(hexToBytes(params.attesterPubkeyY)));
  inputs.push(...buildPaddedMerkleProof(params.merkleProof, params.merkleDepth));
  inputs.push(params.merkleLeafIndex.toString());
  inputs.push(params.merkleDepth.toString());
  return inputs;
}
