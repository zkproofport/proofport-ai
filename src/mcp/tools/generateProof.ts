import { CIRCUITS, type CircuitId } from '../../config/circuits.js';
import { computeCircuitParams } from '../../input/inputBuilder.js';
import { BbProver } from '../../prover/bbProver.js';
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

export interface GenerateProofResult {
  proof: string;
  publicInputs: string;
  nullifier: string;
  signalHash: string;
  cached?: boolean;
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

/**
 * Generate a ZK proof for a given circuit.
 *
 * 1. Rate limit check (if rateLimiter provided)
 * 2. Cache lookup (if proofCache provided)
 * 3. Validates circuitId is in CIRCUITS
 * 4. Calls computeCircuitParams() to construct the circuit parameters
 * 5. Calls bbProver.prove() with the resulting params
 * 6. Caches result (if proofCache provided)
 * 7. Returns proof, publicInputs, nullifier, signalHash
 */
export async function generateProof(
  input: GenerateProofInput,
  deps: GenerateProofDeps,
): Promise<GenerateProofResult> {
  const { address, signature, scope, circuitId, countryList, isIncluded } = input;

  // Validate circuitId
  if (!(circuitId in CIRCUITS)) {
    throw new Error(`Unknown circuit: ${circuitId}. Supported: ${Object.keys(CIRCUITS).join(', ')}`);
  }

  // Rate limit check
  if (deps.rateLimiter) {
    const rateResult = await deps.rateLimiter.check(address);
    if (!rateResult.allowed) {
      throw new Error(`Rate limit exceeded. Retry after ${rateResult.retryAfter} seconds.`);
    }
  }

  // Cache lookup
  if (deps.proofCache) {
    const cached = await deps.proofCache.get(circuitId, { address, scope, countryList, isIncluded });
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  // Compute circuit parameters (fetches attestation data, computes nullifier, etc.)
  const params = await computeCircuitParams(
    {
      address,
      signature,
      scope,
      circuitId: circuitId as CircuitId,
      countryList,
      isIncluded,
    },
    deps.easGraphqlEndpoint,
    deps.rpcUrls,
  );

  // Generate proof using bb CLI
  const bbProver = new BbProver({
    bbPath: deps.bbPath,
    nargoPath: deps.nargoPath,
    circuitsDir: deps.circuitsDir,
  });

  const result = await bbProver.prove(circuitId as CircuitId, params);

  // Convert bytes to hex strings
  const nullifier = '0x' + Array.from(params.nullifierBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const signalHash = '0x' + Array.from(params.signalHash).map(b => b.toString(16).padStart(2, '0')).join('');

  const proofResult: GenerateProofResult = {
    proof: result.proof,
    publicInputs: result.publicInputs,
    nullifier,
    signalHash,
  };

  // Cache the result
  if (deps.proofCache) {
    await deps.proofCache.set(circuitId, { address, scope, countryList, isIncluded }, proofResult);
  }

  return proofResult;
}
