import { ethers } from 'ethers';
import { VERIFIER_ABI, verifyProofOnChain } from '@zkproofport-app/core';
import { getVerifierAddress } from '../config/deployments.js';
import { isCanonicalCircuitId } from '../config/circuitIds.js';

export interface VerifyOnChainParams {
  proof: string;
  publicInputs: string[];
  circuitId: string;
  chainId: string;
  rpcUrl: string;
}

export interface VerifyOnChainResult {
  isValid: boolean;
  verifierAddress: string;
}

/**
 * Verify a ZK proof on-chain by calling the deployed verifier contract.
 *
 * Looks up the verifier address via getVerifierAddress(circuitId, chainId),
 * then calls verify(proof, publicInputs) on it through core's
 * `verifyProofOnChain`. The proof and public inputs are passed through
 * unchanged; core's `parseProofForOnChain` is not applied.
 *
 * @throws If no verifier is found for the given chainId/circuitId combination.
 * @throws If the on-chain contract call reverts or fails.
 */
export async function verifyOnChain(params: VerifyOnChainParams): Promise<VerifyOnChainResult> {
  const { proof, publicInputs, circuitId, chainId, rpcUrl } = params;

  const verifierAddress = getVerifierAddress(circuitId, chainId);
  if (!verifierAddress || !isCanonicalCircuitId(circuitId)) {
    throw new Error(
      `No verifier found for circuit "${circuitId}" on chain "${chainId}"`
    );
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const result = await verifyProofOnChain(
    circuitId,
    { proofHex: proof, publicInputsHex: publicInputs, numPublicInputs: publicInputs.length },
    provider,
    { address: verifierAddress, chainId: Number(chainId), abi: VERIFIER_ABI },
  );

  // Core reports a failed call as `{ valid: false, error }`. This server has
  // always thrown for that case, so a revert is not mistaken for a proof that
  // verified as false.
  if (result.error !== undefined) {
    throw new Error(`On-chain verification failed: ${result.error}`);
  }
  return { isValid: result.valid, verifierAddress };
}
