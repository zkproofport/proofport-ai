/**
 * generateProof.ts — MCP tool wrapper for ZK proof generation.
 *
 * Thin adapter over BbProver + computeCircuitParams.
 * Used by MCP server and unit tests.
 */

import { ethers } from 'ethers';
import { CIRCUITS } from '../../config/circuits.js';
import { BbProver } from '../../prover/bbProver.js';
import { computeCircuitParams } from '../../input/inputBuilder.js';
import type { RateLimiter } from '../../redis/rateLimiter.js';
import type { ProofCache } from '../../redis/proofCache.js';

export interface GenerateProofInput {
  address: string;
  signature: string;
  scope: string;
  circuitId: string;
  countryList?: string[];
  isIncluded?: boolean;
}

export interface GenerateProofDeps {
  easGraphqlEndpoint: string;
  rpcUrls: string[];
  bbPath: string;
  nargoPath: string;
  circuitsDir: string;
  rateLimiter?: RateLimiter;
  proofCache?: ProofCache;
}

export interface GenerateProofOutput {
  proof: string;
  publicInputs: string;
  nullifier: string;
  signalHash: string;
  cached?: boolean;
}

/**
 * Generate a zero-knowledge proof for the given circuit and input parameters.
 *
 * @throws Error if circuitId is unknown, rate limit exceeded, or proof generation fails.
 */
export async function generateProof(
  input: GenerateProofInput,
  deps: GenerateProofDeps,
): Promise<GenerateProofOutput> {
  const { address, signature, scope, circuitId, countryList, isIncluded } = input;

  // Validate circuitId
  if (!(circuitId in CIRCUITS)) {
    throw new Error(`Unknown circuit: ${circuitId}`);
  }

  // Rate limit check
  if (deps.rateLimiter) {
    const result = await deps.rateLimiter.check(address);
    if (!result.allowed) {
      throw new Error(`Rate limit exceeded. Retry after ${result.retryAfter} seconds.`);
    }
  }

  // Cache check
  if (deps.proofCache) {
    const cached = await deps.proofCache.get(circuitId, {
      address,
      scope,
      countryList,
      isIncluded,
    });
    if (cached) {
      return {
        proof: cached.proof,
        publicInputs: cached.publicInputs,
        nullifier: cached.nullifier,
        signalHash: cached.signalHash,
        cached: true,
      };
    }
  }

  // Compute circuit params (fetches attestation, builds Merkle tree, etc.)
  const circuitParams = await computeCircuitParams(
    { address, signature, scope, circuitId: circuitId as any, countryList, isIncluded },
    deps.easGraphqlEndpoint,
    deps.rpcUrls,
  );

  // Generate proof via bb CLI
  const bbProver = new BbProver({
    bbPath: deps.bbPath,
    nargoPath: deps.nargoPath,
    circuitsDir: deps.circuitsDir,
  });
  const proofResult = await bbProver.prove(circuitId, circuitParams);

  const nullifier = ethers.hexlify(circuitParams.nullifierBytes);
  const signalHash = ethers.hexlify(circuitParams.signalHash);

  const output: GenerateProofOutput = {
    proof: proofResult.proof,
    publicInputs: proofResult.publicInputs,
    nullifier,
    signalHash,
  };

  // Cache the result
  if (deps.proofCache) {
    await deps.proofCache.set(
      circuitId,
      { address, scope, countryList, isIncluded },
      { proof: proofResult.proof, publicInputs: proofResult.publicInputs, nullifier, signalHash },
    );
  }

  return output;
}
