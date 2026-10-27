import { ethers } from 'ethers';
import { RPC_ENDPOINTS, verifyProofOnChain } from '@zkproofport-app/core';
import { isCanonicalCircuitId } from './circuits.js';
import type { VerifyResult, ProveResponse } from './types.js';

/**
 * Public RPC per chain this SDK verifies on: core's endpoints plus the two
 * Ethereum chains the AI server reports OIDC/Coinbase proofs on (core 0.2.0
 * lists only Base, Base Sepolia and GIWA Sepolia).
 *
 * Never the `rpcUrl` a prove response carries. A response is written by the
 * server whose proof is being checked; an RPC it names can answer `true` to
 * any call as easily as a verifier address it names can. Checked 2026-10-27:
 * both publicnode URLs answer `eth_chainId` with their chain and return code
 * for the pinned verifiers (11155111 0x7fc2…4a8a, 1 0xf3d5…9d0c).
 */
export const VERIFY_RPC_URLS: Readonly<Record<number, string>> = Object.freeze({
  ...RPC_ENDPOINTS,
  1: 'https://ethereum-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
});

/** The RPC to verify on `chainId`. Throws naming the chain when there is none. */
export function verifyRpcUrl(chainId: number): string {
  const url = VERIFY_RPC_URLS[chainId];
  if (!url) {
    throw new Error(
      `No RPC to verify on chain ${chainId}. Known chains: ${Object.keys(VERIFY_RPC_URLS).join(', ')}.`,
    );
  }
  return url;
}

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
 * Verify a proof on-chain against ZKProofport's pinned verifier.
 *
 * What the response says about its verifier is a claim, never an instruction:
 *  - the contract is core's pinned deployment of `circuit` on `claim.chainId`
 *    (`PINNED_VERIFIERS`); a chain with no deployment of that circuit is refused;
 *  - `claim.verifierAddress` is compared with it, and a different address is
 *    refused rather than called;
 *  - the RPC is {@link VERIFY_RPC_URLS}, not the response's `rpcUrl`.
 * Core also runs the circuit's issuer check before the contract call: the OIDC
 * provider key against the live Google/Microsoft JWKS, and the signer-list root
 * for Coinbase, Country and GIWA. Any failure is `{ valid: false, error }`.
 *
 * @param circuit - Canonical circuit id the proof was generated for
 * @param claim - `verification` from the ProveResponse
 * @param proof - Raw proof hex
 * @param publicInputs - Concatenated public inputs hex
 */
export async function verifyOnChain(
  circuit: string,
  claim: { chainId: number; verifierAddress: string },
  proof: string,
  publicInputs: string,
): Promise<VerifyResult> {
  if (!isCanonicalCircuitId(circuit)) {
    return { valid: false, error: `Unknown circuit '${circuit}'; cannot verify it on-chain.` };
  }
  const chainId = claim.chainId;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return { valid: false, error: `The response names chain '${String(chainId)}', which is not a chain id.` };
  }
  if (typeof claim.verifierAddress !== 'string') {
    return { valid: false, error: 'The response names no verifier address; refusing to guess one.' };
  }
  let rpcUrl: string;
  try {
    rpcUrl = verifyRpcUrl(chainId);
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const publicInputsArray = splitPublicInputs(publicInputs);

  const result = await verifyProofOnChain(
    circuit,
    { proofHex: proof, publicInputsHex: publicInputsArray, numPublicInputs: publicInputsArray.length },
    provider,
    { chainId },
    { verifierAddress: claim.verifierAddress, chainId },
  );
  if (result.error !== undefined) {
    return { valid: false, error: `Verification failed: ${result.error}` };
  }
  return { valid: result.valid === true };
}

/**
 * Verify a proof from a ProveResponse against the pinned verifier for its
 * circuit and chain. See {@link verifyOnChain} for what is and is not trusted.
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
