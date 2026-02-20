/**
 * verifyProof.ts — MCP tool wrapper for on-chain proof verification.
 *
 * Thin adapter over verifyOnChain from prover/verifier.
 * Used by MCP server and unit tests.
 */

import { CIRCUITS } from '../../config/circuits.js';
import { VERIFIER_ADDRESSES } from '../../config/contracts.js';
import { verifyOnChain } from '../../prover/verifier.js';

export interface VerifyProofInput {
  proof: string;
  publicInputs: string[];
  circuitId: string;
  chainId?: string;
}

export interface VerifyProofDeps {
  rpcUrl: string;
  defaultChainId: string;
}

export interface VerifyProofOutput {
  isValid: boolean;
  verifierAddress: string;
  chainId: string;
}

/**
 * Verify a ZK proof on-chain using the deployed verifier contract.
 *
 * @throws Error if circuitId is unknown or no verifier is deployed for the given chainId.
 */
export async function verifyProof(
  input: VerifyProofInput,
  deps: VerifyProofDeps,
): Promise<VerifyProofOutput> {
  const { proof, publicInputs, circuitId } = input;
  const chainId = input.chainId || deps.defaultChainId;

  // Validate circuitId
  if (!(circuitId in CIRCUITS)) {
    throw new Error(`Unknown circuit: ${circuitId}`);
  }

  // Validate verifier exists for this chain/circuit
  const chainVerifiers = VERIFIER_ADDRESSES[chainId];
  if (!chainVerifiers || !chainVerifiers[circuitId]) {
    throw new Error(
      `No verifier deployed for circuit "${circuitId}" on chain "${chainId}"`,
    );
  }

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
