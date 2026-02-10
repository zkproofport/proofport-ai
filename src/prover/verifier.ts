import { ethers } from 'ethers';
import { VERIFIER_ADDRESSES } from '../config/contracts.js';

const VERIFIER_ABI = [
  'function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool)',
];

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
 * Looks up the verifier address from VERIFIER_ADDRESSES[chainId][circuitId],
 * then calls verify(proof, publicInputs) on the contract.
 *
 * @throws If no verifier is found for the given chainId/circuitId combination.
 * @throws If the on-chain contract call reverts or fails.
 */
export async function verifyOnChain(params: VerifyOnChainParams): Promise<VerifyOnChainResult> {
  const { proof, publicInputs, circuitId, chainId, rpcUrl } = params;

  // Look up verifier address
  const chainVerifiers = VERIFIER_ADDRESSES[chainId];
  if (!chainVerifiers || !chainVerifiers[circuitId]) {
    throw new Error(
      `No verifier found for circuit "${circuitId}" on chain "${chainId}"`
    );
  }

  const verifierAddress = chainVerifiers[circuitId];

  // Create provider and contract instance (ethers v6)
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const verifier = new ethers.Contract(verifierAddress, VERIFIER_ABI, provider);

  try {
    const isValid: boolean = await verifier.verify(proof, publicInputs);
    return { isValid, verifierAddress };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`On-chain verification failed: ${message}`);
  }
}
