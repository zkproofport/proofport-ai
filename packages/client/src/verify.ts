import { ethers } from 'ethers';
import type { ClientConfig, CircuitId, VerifyResult } from './types.js';
import { VERIFIER_ADDRESSES, DEFAULT_PAYMENT_RPC } from './constants.js';

// UltraVerifier ABI — 2 arguments: proof bytes + publicInputs bytes32[]
const VERIFIER_ABI = [
  'function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool)',
];

/**
 * Split concatenated public inputs hex into array of bytes32 values.
 * Input: "0xaabb...ccdd" (N*32 bytes)
 * Output: ["0xaabb...32bytes", "0xccdd...32bytes", ...]
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
 * Verify a ZK proof on-chain against the deployed verifier contract.
 *
 * @param config - Client configuration
 * @param circuitId - Circuit identifier (canonical)
 * @param proof - Raw proof hex from prove response
 * @param publicInputs - Concatenated public inputs hex from prove response
 * @param chainId - Chain ID where verifier is deployed (default: 84532 = Base Sepolia)
 * @param rpcUrl - Optional RPC URL override
 */
export async function verifyOnChain(
  config: ClientConfig,
  circuitId: CircuitId,
  proof: string,
  publicInputs: string,
  chainId: string = '84532',
  rpcUrl?: string,
): Promise<VerifyResult> {
  const verifiersByChain = VERIFIER_ADDRESSES[chainId];
  if (!verifiersByChain) {
    return { valid: false, error: `No verifier addresses for chain ${chainId}` };
  }

  const verifierAddress = verifiersByChain[circuitId];
  if (!verifierAddress) {
    return { valid: false, error: `No verifier for circuit ${circuitId} on chain ${chainId}` };
  }

  const resolvedRpcUrl = rpcUrl || config.paymentRpcUrl || DEFAULT_PAYMENT_RPC['base-sepolia'];
  const provider = new ethers.JsonRpcProvider(resolvedRpcUrl);
  const verifier = new ethers.Contract(verifierAddress, VERIFIER_ABI, provider);

  // Split publicInputs into bytes32[] array
  const publicInputsArray = splitPublicInputs(publicInputs);

  try {
    const result = await verifier.verify(proof, publicInputsArray);
    return { valid: result === true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, error: `On-chain verification failed: ${message}` };
  }
}
