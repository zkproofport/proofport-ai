import { ethers } from 'ethers';
import { VERIFIER_ABI, verifyProofOnChain } from '@zkproofport-app/core';
import { isCanonicalCircuitId } from './circuits.js';
import type { VerifyResult, ProveResponse } from './types.js';

/**
 * Split concatenated public inputs hex into array of bytes32 values.
 */
function splitPublicInputs(publicInputsHex: string): string[] {
  const hex = publicInputsHex.startsWith('0x') ? publicInputsHex.slice(2) : publicInputsHex;
  const chunks: string[] = [];
  for (let i = 0; i < hex.length; i += 64) {
    chunks.push('0x' + hex.slice(i, i + 64));
  }
  return chunks;
}

/**
 * Verify a ZK proof on-chain using server-provided verification info.
 *
 * The contract call is core's `verifyProofOnChain`; the proof and the split
 * public inputs are passed through as they are.
 *
 * @param circuit - Canonical circuit id the proof was generated for
 * @param verification - Chain info from ProveResponse (chainId, verifierAddress, rpcUrl)
 * @param proof - Raw proof hex
 * @param publicInputs - Concatenated public inputs hex
 */
export async function verifyOnChain(
  circuit: string,
  verification: { chainId: number; verifierAddress: string; rpcUrl: string },
  proof: string,
  publicInputs: string,
): Promise<VerifyResult> {
  if (!isCanonicalCircuitId(circuit)) {
    return { valid: false, error: `Unknown circuit '${circuit}'; cannot verify it on-chain.` };
  }
  const provider = new ethers.JsonRpcProvider(verification.rpcUrl);
  const publicInputsArray = splitPublicInputs(publicInputs);

  const result = await verifyProofOnChain(
    circuit,
    { proofHex: proof, publicInputsHex: publicInputsArray, numPublicInputs: publicInputsArray.length },
    provider,
    { address: verification.verifierAddress, chainId: verification.chainId, abi: VERIFIER_ABI },
  );
  if (result.error !== undefined) {
    return { valid: false, error: `On-chain verification failed: ${result.error}` };
  }
  return { valid: result.valid === true };
}

/**
 * Verify a proof using the verification info from a ProveResponse.
 * Convenience wrapper that extracts verification data from the prove result.
 *
 * @param result - The full ProveResponse from generateProof()
 * @returns VerifyResult
 *
 * @example
 * ```typescript
 * const result = await generateProof(config, signers, params);
 * const verified = await verifyProof(result);
 * console.log(verified.valid); // true
 * ```
 */
export async function verifyProof(result: ProveResponse): Promise<VerifyResult> {
  if (!result.verification) {
    return { valid: false, error: 'No verification info in response (verifier not deployed on this network)' };
  }
  return verifyOnChain(result.circuit, result.verification, result.proof, result.publicInputs);
}
