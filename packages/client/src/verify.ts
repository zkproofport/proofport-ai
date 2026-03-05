import { ethers } from 'ethers';
import type { VerifyResult, ProveResponse } from './types.js';

const VERIFIER_ABI = [
  'function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool)',
];

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
 * @param verification - Chain info from ProveResponse (chainId, verifierAddress, rpcUrl)
 * @param proof - Raw proof hex
 * @param publicInputs - Concatenated public inputs hex
 */
export async function verifyOnChain(
  verification: { chainId: number; verifierAddress: string; rpcUrl: string },
  proof: string,
  publicInputs: string,
): Promise<VerifyResult> {
  const provider = new ethers.JsonRpcProvider(verification.rpcUrl);
  const verifier = new ethers.Contract(verification.verifierAddress, VERIFIER_ABI, provider);
  const publicInputsArray = splitPublicInputs(publicInputs);

  try {
    const result = await verifier.verify(proof, publicInputsArray);
    return { valid: result === true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, error: `On-chain verification failed: ${message}` };
  }
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
  return verifyOnChain(result.verification, result.proof, result.publicInputs);
}
