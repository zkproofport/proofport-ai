/**
 * flowManager.ts — Redis-backed flow state machine for multi-turn proof generation.
 *
 * Sits ABOVE skillHandler.ts and orchestrates the full signing → payment → proof flow.
 * Each flow is identified by a UUID flowId and stored in Redis.
 *
 * Redis key patterns:
 *   flow:{flowId}        — main flow record (TTL = signingTtlSeconds)
 *   flow:req:{requestId} — reverse lookup from requestId to flowId (same TTL)
 *
 * Rules:
 *   - NO hardcoded fallbacks or default values
 *   - NO log truncation (log full values)
 *   - All errors are descriptive with caller guidance
 *   - publishFlowEvent fires after every phase transition
 */

import { randomUUID } from 'crypto';
import type { RedisClient } from '../redis/client.js';
import {
  type SkillDeps,
  type GenerateProofResult,
  handleRequestSigning,
  handleCheckStatus,
  handleRequestPayment,
  handleGenerateProof,
} from './skillHandler.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProofFlow {
  flowId: string;
  circuitId: string;
  scope: string;
  countryList?: string[];
  isIncluded?: boolean;
  phase: 'signing' | 'payment' | 'generating' | 'completed' | 'failed' | 'expired';
  requestId: string;
  signingUrl: string;
  paymentUrl?: string;
  proofResult?: GenerateProofResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

/** Parameters for creating a new flow. */
export interface CreateFlowParams {
  circuitId: string;
  scope: string;
  countryList?: string[];
  isIncluded?: boolean;
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

function flowKey(flowId: string): string {
  return `flow:${flowId}`;
}

function flowReqKey(requestId: string): string {
  return `flow:req:${requestId}`;
}

// ─── Terminal phase check ─────────────────────────────────────────────────────

function isTerminalPhase(phase: ProofFlow['phase']): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'expired';
}

// ─── Redis helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the TTL to use when saving a flow record.
 * Attempts to preserve the remaining TTL from Redis.
 * Falls back to signingTtlSeconds if the key has no TTL or has expired.
 */
async function resolveTtl(redis: RedisClient, key: string, signingTtlSeconds: number): Promise<number> {
  const remaining = await redis.ttl(key);
  if (remaining > 0) return remaining;
  return signingTtlSeconds;
}

/**
 * Save a flow record back to Redis, preserving the remaining TTL where possible.
 */
async function saveFlow(
  redis: RedisClient,
  flow: ProofFlow,
  signingTtlSeconds: number,
): Promise<void> {
  const key = flowKey(flow.flowId);
  const ttl = await resolveTtl(redis, key, signingTtlSeconds);
  await redis.set(key, JSON.stringify(flow), 'EX', ttl);
}

// ─── SSE event publisher ──────────────────────────────────────────────────────

/**
 * Publish a flow state update to the Redis pub/sub channel for this flow.
 * SSE subscribers listen on `flow:events:{flowId}` to get real-time updates.
 */
export async function publishFlowEvent(
  redis: RedisClient,
  flowId: string,
  flow: ProofFlow,
): Promise<void> {
  const channel = `flow:events:${flowId}`;
  await redis.publish(channel, JSON.stringify(flow));
  console.log('[flowManager] Published flow event:', JSON.stringify({
    channel,
    flowId,
    phase: flow.phase,
  }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new proof flow.
 *
 * Calls handleRequestSigning to initialise a signing session,
 * stores the ProofFlow in Redis, and creates a reverse lookup
 * from requestId → flowId.
 *
 * @throws Error if any required param is missing or handleRequestSigning fails
 */
export async function createFlow(
  params: CreateFlowParams,
  deps: SkillDeps,
): Promise<ProofFlow> {
  if (!params.circuitId) {
    throw new Error('circuitId is required to create a flow.');
  }
  if (!params.scope || params.scope.trim().length === 0) {
    throw new Error('scope is required and must be a non-empty string.');
  }

  const signingResult = await handleRequestSigning(
    {
      circuitId: params.circuitId,
      scope: params.scope,
      countryList: params.countryList,
      isIncluded: params.isIncluded,
    },
    deps,
  );

  const now = new Date().toISOString();
  const flowId = randomUUID();

  const flow: ProofFlow = {
    flowId,
    circuitId: params.circuitId,
    scope: params.scope,
    ...(params.countryList !== undefined && { countryList: params.countryList }),
    ...(params.isIncluded !== undefined && { isIncluded: params.isIncluded }),
    phase: 'signing',
    requestId: signingResult.requestId,
    signingUrl: signingResult.signingUrl,
    createdAt: now,
    updatedAt: now,
    expiresAt: signingResult.expiresAt,
  };

  // Store main flow record
  const key = flowKey(flowId);
  await deps.redis.set(key, JSON.stringify(flow), 'EX', deps.signingTtlSeconds);

  // Store reverse lookup: requestId → flowId
  await deps.redis.set(
    flowReqKey(signingResult.requestId),
    flowId,
    'EX',
    deps.signingTtlSeconds,
  );

  console.log('[flowManager] Created flow:', JSON.stringify({
    flowId,
    requestId: signingResult.requestId,
    circuitId: params.circuitId,
    scope: params.scope,
    expiresAt: signingResult.expiresAt,
  }));

  return flow;
}

/**
 * Advance a flow through the state machine based on current signing/payment status.
 *
 * State transitions:
 *   signing  → signing   (no change — still waiting for user to sign)
 *   signing  → expired   (session expired)
 *   signing  → payment   (signing done, payment required)
 *   payment  → payment   (no change — still waiting for payment)
 *   payment  → generating→ completed/failed (payment done, generates proof)
 *   ready    → generating→ completed/failed (payment disabled, generates proof)
 *
 * Terminal phases (completed, failed, expired) are returned as-is.
 *
 * @throws Error if flowId is missing or the flow is not found in Redis
 */
export async function advanceFlow(flowId: string, deps: SkillDeps): Promise<ProofFlow> {
  if (!flowId || flowId.trim().length === 0) {
    throw new Error('flowId is required to advance a flow.');
  }

  const flow = await getFlow(flowId, deps.redis);
  if (!flow) {
    throw new Error(`Flow not found: "${flowId}". It may have expired or never existed.`);
  }

  // Terminal phases — nothing to advance
  if (isTerminalPhase(flow.phase)) {
    console.log('[flowManager] Flow already in terminal phase:', JSON.stringify({ flowId, phase: flow.phase }));
    return flow;
  }

  // Check current status from the signing layer
  const statusResult = await handleCheckStatus({ requestId: flow.requestId }, deps);

  const now = new Date().toISOString();

  // ── Expired ───────────────────────────────────────────────────────────────
  if (statusResult.phase === 'expired') {
    flow.phase = 'expired';
    flow.updatedAt = now;
    await saveFlow(deps.redis, flow, deps.signingTtlSeconds);
    await publishFlowEvent(deps.redis, flowId, flow);
    console.log('[flowManager] Flow expired:', JSON.stringify({ flowId, requestId: flow.requestId }));
    return flow;
  }

  // ── Still waiting for signing ─────────────────────────────────────────────
  if (statusResult.phase === 'signing') {
    // No transition — return current state
    console.log('[flowManager] Flow awaiting signing:', JSON.stringify({ flowId, requestId: flow.requestId }));
    return flow;
  }

  // ── Signing done, payment required ───────────────────────────────────────
  if (statusResult.phase === 'payment' && flow.phase === 'signing') {
    const paymentResult = await handleRequestPayment({ requestId: flow.requestId }, deps);
    flow.phase = 'payment';
    flow.paymentUrl = paymentResult.paymentUrl;
    flow.updatedAt = now;
    await saveFlow(deps.redis, flow, deps.signingTtlSeconds);
    await publishFlowEvent(deps.redis, flowId, flow);
    console.log('[flowManager] Flow transitioned to payment:', JSON.stringify({
      flowId,
      requestId: flow.requestId,
      paymentUrl: paymentResult.paymentUrl,
    }));
    return flow;
  }

  // ── Payment phase, still waiting ──────────────────────────────────────────
  if (statusResult.phase === 'payment' && flow.phase === 'payment') {
    console.log('[flowManager] Flow awaiting payment:', JSON.stringify({ flowId, requestId: flow.requestId }));
    return flow;
  }

  // ── Ready: generate proof ─────────────────────────────────────────────────
  if (
    statusResult.phase === 'ready' &&
    flow.phase !== 'generating' &&
    flow.phase !== 'completed'
  ) {
    // Transition to generating first — so concurrent reads see the right phase
    flow.phase = 'generating';
    flow.updatedAt = now;
    await saveFlow(deps.redis, flow, deps.signingTtlSeconds);
    await publishFlowEvent(deps.redis, flowId, flow);
    console.log('[flowManager] Flow transitioning to generating:', JSON.stringify({
      flowId,
      requestId: flow.requestId,
    }));

    try {
      const proofResult = await handleGenerateProof({ requestId: flow.requestId }, deps);
      flow.phase = 'completed';
      flow.proofResult = proofResult;
      flow.updatedAt = new Date().toISOString();
      console.log('[flowManager] Flow completed, proof generated:', JSON.stringify({
        flowId,
        proofId: proofResult.proofId,
        nullifier: proofResult.nullifier,
        signalHash: proofResult.signalHash,
        verifyUrl: proofResult.verifyUrl,
        cached: proofResult.cached,
      }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      flow.phase = 'failed';
      flow.error = message;
      flow.updatedAt = new Date().toISOString();
      console.error('[flowManager] Flow failed during proof generation:', JSON.stringify({
        flowId,
        requestId: flow.requestId,
        error: message,
      }));
    }

    await saveFlow(deps.redis, flow, deps.signingTtlSeconds);
    await publishFlowEvent(deps.redis, flowId, flow);
    return flow;
  }

  // ── Already generating (concurrent call) ─────────────────────────────────
  if (flow.phase === 'generating') {
    console.log('[flowManager] Flow already generating:', JSON.stringify({ flowId, requestId: flow.requestId }));
    return flow;
  }

  // Fallback — return current flow unchanged
  console.log('[flowManager] Flow advance no-op:', JSON.stringify({ flowId, phase: flow.phase, statusPhase: statusResult.phase }));
  return flow;
}

/**
 * Retrieve a flow by its flowId.
 *
 * Returns null if the flow does not exist or has been evicted from Redis.
 */
export async function getFlow(flowId: string, redis: RedisClient): Promise<ProofFlow | null> {
  if (!flowId || flowId.trim().length === 0) {
    throw new Error('flowId is required.');
  }

  const data = await redis.get(flowKey(flowId));
  if (!data) return null;
  return JSON.parse(data) as ProofFlow;
}

/**
 * Retrieve a flow by its signing requestId (reverse lookup).
 *
 * Returns null if no flow is associated with the given requestId
 * or if the flow has been evicted from Redis.
 */
export async function getFlowByRequestId(
  requestId: string,
  redis: RedisClient,
): Promise<ProofFlow | null> {
  if (!requestId || requestId.trim().length === 0) {
    throw new Error('requestId is required.');
  }

  const flowId = await redis.get(flowReqKey(requestId));
  if (!flowId) return null;
  return getFlow(flowId, redis);
}
