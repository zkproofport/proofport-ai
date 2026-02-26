import { randomUUID } from 'crypto';
import type { RedisClient } from './client.js';
import { PROOF_RESULT_TTL } from './constants.js';
const PROOF_RESULT_PREFIX = 'proof:result:';

export interface StoredProofResult {
  proof: string;
  publicInputs: string;
  circuitId: string;
  nullifier: string;
  signalHash: string;
  attestation?: {
    document: string;  // base64-encoded COSE Sign1
    mode: string;      // 'nitro' | 'local'
    proofHash: string;
    timestamp: number;
  };
}

interface ProofResultRecord extends StoredProofResult {
  proofId: string;
  createdAt: string;
}

/**
 * Store a proof result in Redis and return its proofId.
 * The stored result can be retrieved later for on-chain verification.
 */
export async function storeProofResult(
  redis: RedisClient,
  result: StoredProofResult,
): Promise<string> {
  const proofId = randomUUID();
  const record: ProofResultRecord = {
    ...result,
    proofId,
    createdAt: new Date().toISOString(),
  };

  const key = `${PROOF_RESULT_PREFIX}${proofId}`;
  await redis.set(key, JSON.stringify(record), 'EX', PROOF_RESULT_TTL);

  return proofId;
}

/**
 * Retrieve a stored proof result by proofId.
 * Returns null if not found or expired.
 */
export async function getProofResult(
  redis: RedisClient,
  proofId: string,
): Promise<ProofResultRecord | null> {
  const key = `${PROOF_RESULT_PREFIX}${proofId}`;
  const data = await redis.get(key);

  if (!data) return null;

  return JSON.parse(data) as ProofResultRecord;
}
