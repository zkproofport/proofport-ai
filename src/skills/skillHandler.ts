/**
 * skillHandler.ts — Canonical logic for active agent skills.
 *
 * This is the SINGLE SOURCE OF TRUTH for all tool/skill logic in proofport-ai.
 * All 4 protocol adapters call into these functions:
 *   - chat/chatHandler.ts  (LLM tool calls)
 *   - mcp/server.ts        (MCP tool calls)
 *   - a2a/taskWorker.ts    (A2A task processing)
 *   - api/restRoutes.ts    (REST API)
 *
 * Active skills:
 *   - Skill 6: get_supported_circuits
 *
 * Rules:
 *   - NO hardcoded fallbacks or default values for required params
 *   - NO log truncation (log full values)
 *   - All errors are descriptive with guidance for the caller
 */

import { createLogger } from '../logger.js';

const log = createLogger('Skill');
import { CIRCUITS } from '../config/circuits.js';
import { getChainVerifiers } from '../config/deployments.js';
import type { RedisClient } from '../redis/client.js';
import type { RateLimiter } from '../redis/rateLimiter.js';
import type { ProofCache } from '../redis/proofCache.js';
import type { TeeProvider } from '../tee/types.js';

// ─── Dependencies ─────────────────────────────────────────────────────────────

/** Shared dependencies injected into all skill handlers. */
export interface SkillDeps {
  redis: RedisClient;
  /** Payment mode: disabled skips payment, testnet/mainnet require it */
  paymentMode: 'disabled' | 'testnet' | 'mainnet';
  /** Human-readable proof price (e.g., "$0.10") */
  paymentProofPrice: string;
  /** EAS GraphQL endpoint for attestation fetching */
  easGraphqlEndpoint: string;
  /** RPC URLs for Base chain (attestation TX fetching) */
  rpcUrls: string[];
  /** Path to bb binary */
  bbPath: string;
  /** Path to compiled circuit artifacts directory */
  circuitsDir: string;
  /** RPC URL for on-chain verification (verifier contract calls) */
  chainRpcUrl: string;
  /** Optional rate limiter (per-address) */
  rateLimiter?: RateLimiter;
  /** Optional proof cache */
  proofCache?: ProofCache;
  /** Optional TEE provider for enclave-based proof generation */
  teeProvider?: TeeProvider;
  /** TEE mode: 'disabled' | 'local' | 'nitro' */
  teeMode: string;
}

// ─── Skill 6: get_supported_circuits ─────────────────────────────────────────

/** Parameters for listing supported circuits (all optional). */
export interface GetSupportedCircuitsParams {
  chainId?: string;
}

/** A single circuit entry in the response. */
export interface CircuitInfo {
  id: string;
  displayName: string;
  description: string;
  requiredInputs: readonly string[];
  verifierAddress?: string;
}

/** Result of listing supported circuits. */
export interface GetSupportedCircuitsResult {
  circuits: CircuitInfo[];
  chainId: string;
}

/**
 * Return metadata for all supported circuits, including verifier addresses
 * for the specified chain.
 */
export function handleGetSupportedCircuits(
  params: GetSupportedCircuitsParams,
  paymentMode: 'disabled' | 'testnet' | 'mainnet' = 'testnet',
): GetSupportedCircuitsResult {
  const defaultChainId = paymentMode === 'mainnet' ? '8453' : '84532';
  const chainId = params.chainId || defaultChainId;
  const chainVerifiers = getChainVerifiers(chainId);

  const circuits: CircuitInfo[] = Object.values(CIRCUITS).map(circuit => ({
    id: circuit.id,
    displayName: circuit.displayName,
    description: circuit.description,
    requiredInputs: circuit.requiredInputs,
    ...(chainVerifiers[circuit.id] && { verifierAddress: chainVerifiers[circuit.id] }),
  }));

  return { circuits, chainId };
}
