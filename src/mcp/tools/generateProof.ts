import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import { CIRCUITS, type CircuitId } from '../../config/circuits.js';
import { computeCircuitParams, computeSignalHash } from '../../input/inputBuilder.js';
import { BbProver } from '../../prover/bbProver.js';
import type { RateLimiter } from '../../redis/rateLimiter.js';
import type { ProofCache } from '../../redis/proofCache.js';
import type { SigningRequestRecord } from '../../signing/types.js';
import type { RedisClient } from '../../redis/client.js';
import type { TeeProvider } from '../../tee/types.js';
import type { AttestationResult } from '../../tee/types.js';

export interface GenerateProofInput {
  address?: string;        // Optional — resolved from sign-page when using web signing
  signature?: string;      // Optional — omit to use web signing flow
  requestId?: string;      // For resuming after web signing
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
  attestation?: AttestationResult;
}

export interface SigningRequestResult {
  status: 'awaiting_signature';
  signingUrl: string;
  requestId: string;
  message: string;
}

export interface GenerateProofDeps {
  easGraphqlEndpoint: string;
  rpcUrls: string[];
  bbPath: string;
  nargoPath: string;
  circuitsDir: string;
  rateLimiter?: RateLimiter;
  proofCache?: ProofCache;
  redis?: RedisClient;
  signPageUrl?: string;
  signingTtlSeconds?: number;
  teeProvider?: TeeProvider;
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
): Promise<GenerateProofResult | SigningRequestResult> {
  const { address, signature, requestId, scope, circuitId, countryList, isIncluded } = input;

  // Validate circuitId
  if (!(circuitId in CIRCUITS)) {
    throw new Error(`Unknown circuit: ${circuitId}. Supported: ${Object.keys(CIRCUITS).join(', ')}`);
  }

  // ─── Resolve address + signature (3 modes) ─────────────────────────
  let resolvedAddress: string;
  let resolvedSignature: string;

  if (signature) {
    // Mode 1: Direct signature provided — address required
    if (!address) {
      throw new Error('Address is required when providing a signature directly.');
    }
    resolvedAddress = address;
    resolvedSignature = signature;
  } else if (requestId) {
    // Mode 3: Resume with requestId — get address + signature from Redis
    if (!deps.redis) {
      throw new Error('Redis is required for web signing flow');
    }
    const key = `signing:${requestId}`;
    const data = await deps.redis.get(key);
    if (!data) {
      throw new Error('Signing request not found or expired');
    }
    const record: SigningRequestRecord = JSON.parse(data);
    if (record.status !== 'completed' || !record.signature || !record.address) {
      throw new Error(
        `Signing request is not yet completed (status: ${record.status}). ` +
        `Please wait for the user to sign at the signing page.`
      );
    }
    resolvedAddress = record.address;
    resolvedSignature = record.signature;
    // Clean up used signing request
    await deps.redis.del(key);
  } else {
    // Mode 2: No signature, no requestId — create web signing request
    // Address is NOT required — user will connect wallet on sign-page
    if (!deps.redis || !deps.signPageUrl) {
      throw new Error(
        'Web signing is not configured. Either provide a signature directly, ' +
        'or configure SIGN_PAGE_URL for web signing.'
      );
    }

    const newRequestId = randomUUID();
    const ttl = deps.signingTtlSeconds ?? 300;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    const record: SigningRequestRecord = {
      id: newRequestId,
      scope,
      circuitId,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    const key = `signing:${newRequestId}`;
    await deps.redis.set(key, JSON.stringify(record), 'EX', ttl);

    const signingUrl = `${deps.signPageUrl.replace(/\/$/, '')}/s/${newRequestId}`;

    return {
      status: 'awaiting_signature',
      signingUrl,
      requestId: newRequestId,
      message:
        `Signature required. Please ask the user to open the signing URL and connect their wallet to sign. ` +
        `Then call generate_proof again with requestId: "${newRequestId}".`,
    };
  }

  // Rate limit check (after address is resolved)
  if (deps.rateLimiter) {
    const rateResult = await deps.rateLimiter.check(resolvedAddress);
    if (!rateResult.allowed) {
      throw new Error(`Rate limit exceeded. Retry after ${rateResult.retryAfter} seconds.`);
    }
  }

  // ─── Cache lookup (only when we have a resolved signature) ──────────
  if (deps.proofCache) {
    const cached = await deps.proofCache.get(circuitId, { address: resolvedAddress, scope, countryList, isIncluded });
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  // ─── Compute circuit parameters and generate proof ──────────────────
  const params = await computeCircuitParams(
    {
      address: resolvedAddress,
      signature: resolvedSignature,
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

  // Generate TEE attestation if provider is available
  let attestation: AttestationResult | undefined;
  if (deps.teeProvider && deps.teeProvider.mode !== 'disabled') {
    try {
      const { ethers } = await import('ethers');
      const proofBytes = ethers.getBytes(result.proof);
      const proofHash = ethers.keccak256(proofBytes);
      const att = await deps.teeProvider.generateAttestation(proofHash, { circuitId, scope });
      if (att) {
        attestation = att;
      }
    } catch (error) {
      console.error('[TEE] Failed to generate attestation:', error);
    }
  }

  const proofResult: GenerateProofResult = {
    proof: result.proof,
    publicInputs: result.publicInputs,
    nullifier,
    signalHash,
    ...(attestation && { attestation }),
  };

  // Cache the result
  if (deps.proofCache) {
    await deps.proofCache.set(circuitId, { address: resolvedAddress, scope, countryList, isIncluded }, proofResult);
  }

  return proofResult;
}
