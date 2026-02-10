import { CIRCUITS } from '../../config/circuits.js';
import { VERIFIER_ADDRESSES } from '../../config/contracts.js';
import { verifyOnChain } from '../../prover/verifier.js';

export interface VerifyProofInput {
  proof: string;
  publicInputs: string[];
  circuitId: string;
  chainId?: string;
}

export interface VerifyProofResult {
  isValid: boolean;
  verifierAddress: string;
  chainId: string;
}

export interface VerifyProofDeps {
  rpcUrl: string;
  defaultChainId?: string;
}

/**
 * Verify a ZK proof on-chain.
 *
 * 1. Validates circuitId is in CIRCUITS
 * 2. Looks up verifier address from VERIFIER_ADDRESSES[chainId][circuitId]
 * 3. Calls on-chain verifier.verify(proof, publicInputs) using ethers v6
 * 4. Returns isValid, verifierAddress, chainId
 */
export async function verifyProof(
  input: VerifyProofInput,
  deps: VerifyProofDeps,
): Promise<VerifyProofResult> {
  const { proof, publicInputs, circuitId } = input;
  const chainId = input.chainId || deps.defaultChainId || '84532';

  // Validate circuitId
  if (!(circuitId in CIRCUITS)) {
    throw new Error(`Unknown circuit: ${circuitId}. Supported: ${Object.keys(CIRCUITS).join(', ')}`);
  }

  // Validate verifier exists for this chain/circuit combo
  const chainVerifiers = VERIFIER_ADDRESSES[chainId];
  if (!chainVerifiers || !chainVerifiers[circuitId]) {
    throw new Error(
      `No verifier deployed for circuit "${circuitId}" on chain "${chainId}"`
    );
  }

  // Call on-chain verification
  const result = await verifyOnChain({
    proof,
    publicInputs,
    circuitId,
    chainId,
    rpcUrl: deps.rpcUrl,
  });

  return {
    isValid: result.isValid,
    verifierAddress: result.verifierAddress,
    chainId,
  };
}
