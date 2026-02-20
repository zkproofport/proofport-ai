import express, { type Router, type Request, type Response } from 'express';
import type { TaskStore } from '../a2a/taskStore.js';
import type { TaskEventEmitter } from '../a2a/streaming.js';
import { createRedisClient, type RedisClient } from '../redis/client.js';
import type { RateLimiter } from '../redis/rateLimiter.js';
import type { ProofCache } from '../redis/proofCache.js';
import type { TeeProvider } from '../tee/types.js';
import type { Config } from '../config/index.js';
import { getProofResult } from '../redis/proofResultStore.js';
import { verifyOnChain } from '../prover/verifier.js';
import { VERIFIER_ADDRESSES } from '../config/contracts.js';
import {
  handleRequestSigning,
  handleCheckStatus,
  handleRequestPayment,
  handleGenerateProof,
  handleVerifyProof,
  handleGetSupportedCircuits,
  type SkillDeps,
} from '../skills/skillHandler.js';
import { createFlow, advanceFlow, getFlow } from '../skills/flowManager.js';

/**
 * Split a hex string into an array of bytes32 (32-byte / 64 hex char) elements.
 * bb outputs publicInputs as concatenated field elements.
 */
function splitHexToBytes32(hex: string): string[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += 64) {
    chunks.push('0x' + clean.slice(i, i + 64).padEnd(64, '0'));
  }
  return chunks;
}

export interface RestRoutesDeps {
  taskStore: TaskStore;
  taskEventEmitter: TaskEventEmitter;
  redis: RedisClient;
  config: Config;
  rateLimiter?: RateLimiter;
  proofCache?: ProofCache;
  teeProvider?: TeeProvider;
}

function buildSkillDeps(deps: RestRoutesDeps): SkillDeps {
  const { config, redis, rateLimiter, proofCache, teeProvider } = deps;
  return {
    redis,
    signPageUrl: config.signPageUrl || config.a2aBaseUrl,
    signingTtlSeconds: config.signingTtlSeconds,
    paymentMode: config.paymentMode,
    paymentProofPrice: config.paymentProofPrice,
    easGraphqlEndpoint: config.easGraphqlEndpoint,
    rpcUrls: [config.baseRpcUrl],
    bbPath: config.bbPath,
    nargoPath: config.nargoPath,
    circuitsDir: config.circuitsDir,
    chainRpcUrl: config.chainRpcUrl,
    teeMode: config.teeMode,
    rateLimiter,
    proofCache,
    teeProvider,
  };
}

export function createRestRoutes(deps: RestRoutesDeps): Router {
  const { redis, config } = deps;
  const router = express.Router();

  /**
   * GET /api/v1/circuits
   * Returns list of supported circuits with metadata.
   */
  router.get('/circuits', (req: Request, res: Response) => {
    const chainId = req.query.chainId as string | undefined;
    const result = handleGetSupportedCircuits({ chainId });
    res.json(result);
  });

  /**
   * POST /api/v1/signing
   * Start a proof generation session. Returns signingUrl + requestId.
   */
  router.post('/signing', async (req: Request, res: Response) => {
    try {
      const { circuitId, scope, countryList, isIncluded } = req.body as {
        circuitId?: string;
        scope?: string;
        countryList?: string[];
        isIncluded?: boolean;
      };
      const skillDeps = buildSkillDeps(deps);
      const result = await handleRequestSigning({ circuitId: circuitId ?? '', scope: scope ?? '', countryList, isIncluded }, skillDeps);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  /**
   * GET /api/v1/signing/:requestId/status
   * Check signing and payment status of a proof request.
   */
  router.get('/signing/:requestId/status', async (req: Request, res: Response) => {
    try {
      const { requestId } = req.params;
      const skillDeps = buildSkillDeps(deps);
      const result = await handleCheckStatus({ requestId }, skillDeps);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  /**
   * POST /api/v1/signing/:requestId/payment
   * Initiate USDC payment for a proof request. Returns paymentUrl.
   */
  router.post('/signing/:requestId/payment', async (req: Request, res: Response) => {
    try {
      const { requestId } = req.params;
      const skillDeps = buildSkillDeps(deps);
      const result = await handleRequestPayment({ requestId }, skillDeps);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/v1/proofs
   * Generate a ZK proof (session mode via requestId, or direct mode via address+signature).
   */
  router.post('/proofs', async (req: Request, res: Response) => {
    try {
      const { circuitId, scope, address, signature, requestId, countryList, isIncluded } = req.body as {
        circuitId?: string;
        scope?: string;
        address?: string;
        signature?: string;
        requestId?: string;
        countryList?: string[];
        isIncluded?: boolean;
      };
      const skillDeps = buildSkillDeps(deps);
      const result = await handleGenerateProof(
        { circuitId, scope, address, signature, requestId, countryList, isIncluded },
        skillDeps,
      );

      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  /**
   * GET /api/v1/proofs/:taskId
   * Get task status (legacy A2A task lookup — kept for backward compatibility).
   */
  router.get('/proofs/:taskId', async (req: Request, res: Response) => {
    const { taskId } = req.params;

    try {
      const task = await deps.taskStore.getTask(taskId);

      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const taskData = task as any;
      const state = taskData.status.state;
      const message = taskData.status.message?.parts?.[0]?.text;

      const response: {
        taskId: string;
        state: string;
        message?: string;
        signingUrl?: string;
        requestId?: string;
        proof?: string;
        publicInputs?: string;
        nullifier?: string;
        signalHash?: string;
        error?: string;
      } = {
        taskId: taskData.id,
        state,
      };

      if (message) {
        response.message = message;
      }

      if (state === 'auth-required') {
        const signingData = extractSigningUrlFromTask(taskData);
        if (signingData.signingUrl) response.signingUrl = signingData.signingUrl;
        if (signingData.requestId) response.requestId = signingData.requestId;
      }

      if (state === 'completed') {
        const proofData = extractProofFromTask(taskData);
        if (proofData.proof) response.proof = proofData.proof;
        if (proofData.publicInputs) response.publicInputs = proofData.publicInputs;
        if (proofData.nullifier) response.nullifier = proofData.nullifier;
        if (proofData.signalHash) response.signalHash = proofData.signalHash;
      }

      if (state === 'failed') {
        const proofData = extractProofFromTask(taskData);
        if (proofData.error) response.error = proofData.error;
      }

      res.json(response);
    } catch (error) {
      console.error('Task retrieval error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  /**
   * POST /api/v1/proofs/verify
   * Verify a ZK proof on-chain.
   */
  router.post('/proofs/verify', async (req: Request, res: Response) => {
    try {
      const { circuitId, proof, publicInputs, chainId } = req.body as {
        circuitId?: string;
        proof?: string;
        publicInputs?: string | string[];
        chainId?: string;
      };
      const skillDeps = buildSkillDeps(deps);
      const result = await handleVerifyProof(
        { circuitId: circuitId ?? '', proof: proof ?? '', publicInputs: publicInputs ?? [], chainId },
        skillDeps,
      );
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  /**
   * GET /api/v1/verify/:proofId
   * Verify a stored proof on-chain by proofId (QR code / link verification).
   */
  router.get('/verify/:proofId', async (req: Request, res: Response) => {
    const { proofId } = req.params;

    try {
      const stored = await getProofResult(redis, proofId);

      if (!stored) {
        res.status(404).json({ error: 'Proof not found or expired' });
        return;
      }

      const chainId = '84532'; // Base Sepolia
      const chainVerifiers = VERIFIER_ADDRESSES[chainId];
      if (!chainVerifiers || !chainVerifiers[stored.circuitId]) {
        res.status(400).json({ error: `No verifier deployed for circuit "${stored.circuitId}" on chain "${chainId}"` });
        return;
      }

      // Parse publicInputs — stored as hex string of concatenated bytes32 values
      let publicInputs: string[];
      try {
        const parsed = JSON.parse(stored.publicInputs);
        publicInputs = Array.isArray(parsed) ? parsed : splitHexToBytes32(stored.publicInputs);
      } catch {
        publicInputs = splitHexToBytes32(stored.publicInputs);
      }

      const result = await verifyOnChain({
        proof: stored.proof,
        publicInputs,
        circuitId: stored.circuitId,
        chainId,
        rpcUrl: config.chainRpcUrl,
      });

      res.json({
        proofId,
        circuitId: stored.circuitId,
        nullifier: stored.nullifier,
        isValid: result.isValid,
        verifierAddress: result.verifierAddress,
        chainId,
      });
    } catch (error) {
      console.error('[Verify] Error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Verification failed',
      });
    }
  });

  /**
   * POST /api/v1/flow
   * Start an orchestrated proof flow. Returns flowId, signingUrl, and initial phase.
   */
  router.post('/flow', async (req: Request, res: Response) => {
    try {
      const { circuitId, scope, countryList, isIncluded } = req.body;
      if (!circuitId || !scope) {
        res.status(400).json({ error: 'circuitId and scope are required' });
        return;
      }
      const skillDeps = buildSkillDeps(deps);
      const flow = await createFlow({ circuitId, scope, countryList, isIncluded }, skillDeps);
      res.json(flow);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * GET /api/v1/flow/:flowId
   * Get flow state. Auto-advances if not in a terminal phase.
   */
  router.get('/flow/:flowId', async (req: Request, res: Response) => {
    try {
      const flow = await getFlow(req.params.flowId, deps.redis);
      if (!flow) {
        res.status(404).json({ error: 'Flow not found or expired' });
        return;
      }
      // Auto-advance if not in terminal state
      if (!['completed', 'failed', 'expired'].includes(flow.phase)) {
        const skillDeps = buildSkillDeps(deps);
        const advanced = await advanceFlow(req.params.flowId, skillDeps);
        res.json(advanced);
        return;
      }
      res.json(flow);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * GET /api/v1/flow/:flowId/events
   * SSE stream for real-time flow phase updates.
   * Subscribes to Redis pub/sub on flow:events:{flowId} and polls every 5s as fallback.
   */
  router.get('/flow/:flowId/events', async (req: Request, res: Response) => {
    const { flowId } = req.params;

    // Check flow exists
    const flow = await getFlow(flowId, deps.redis);
    if (!flow) {
      res.status(404).json({ error: 'Flow not found or expired' });
      return;
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send initial state
    res.write(`event: phase\ndata: ${JSON.stringify(flow)}\n\n`);

    if (['completed', 'failed', 'expired'].includes(flow.phase)) {
      res.write(`event: done\ndata: ${JSON.stringify({ flowId })}\n\n`);
      res.end();
      return;
    }

    // Subscribe to Redis pub/sub for instant updates
    // Need a separate Redis connection for subscribing
    const subscriber = createRedisClient(deps.config.redisUrl);
    const channel = `flow:events:${flowId}`;

    await subscriber.subscribe(channel);
    subscriber.on('message', (_ch: string, message: string) => {
      try {
        const flowData = JSON.parse(message);
        res.write(`event: phase\ndata: ${message}\n\n`);
        if (['completed', 'failed', 'expired'].includes(flowData.phase)) {
          res.write(`event: done\ndata: ${JSON.stringify({ flowId })}\n\n`);
          cleanup();
        }
      } catch { /* ignore parse errors */ }
    });

    // Fallback polling every 5 seconds
    const skillDeps = buildSkillDeps(deps);
    const pollInterval = setInterval(async () => {
      try {
        const current = await getFlow(flowId, deps.redis);
        if (!current) {
          res.write(`event: phase\ndata: ${JSON.stringify({ flowId, phase: 'expired' })}\n\n`);
          res.write(`event: done\ndata: ${JSON.stringify({ flowId })}\n\n`);
          cleanup();
          return;
        }
        if (!['completed', 'failed', 'expired'].includes(current.phase)) {
          await advanceFlow(flowId, skillDeps);
        }
      } catch { /* ignore polling errors */ }
    }, 5000);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(pollInterval);
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.quit().catch(() => {});
      res.end();
    };

    req.on('close', cleanup);
  });

  return router;
}

// ─── Task artifact helpers (used by GET /proofs/:taskId) ─────────────────────

interface TaskArtifact {
  id: string;
  mimeType: string;
  parts: Array<{ kind: string; text?: string; data?: unknown }>;
  metadata?: Record<string, unknown>;
}

function extractProofFromTask(task: any): {
  proof?: string;
  publicInputs?: string;
  nullifier?: string;
  signalHash?: string;
  error?: string;
} {
  const result: {
    proof?: string;
    publicInputs?: string;
    nullifier?: string;
    signalHash?: string;
    error?: string;
  } = {};

  if (!task.artifacts || task.artifacts.length === 0) {
    return result;
  }

  for (const artifact of task.artifacts as TaskArtifact[]) {
    for (const part of artifact.parts) {
      if (part.kind === 'data' && part.data) {
        const data = part.data as Record<string, unknown>;
        if (data.proof) result.proof = data.proof as string;
        if (data.publicInputs) result.publicInputs = data.publicInputs as string;
        if (data.nullifier) result.nullifier = data.nullifier as string;
        if (data.signalHash) result.signalHash = data.signalHash as string;
        if (data.error) result.error = data.error as string;
      }
    }
  }

  return result;
}

function extractSigningUrlFromTask(task: any): {
  signingUrl?: string;
  requestId?: string;
} {
  const result: { signingUrl?: string; requestId?: string } = {};

  if (!task.artifacts || task.artifacts.length === 0) {
    return result;
  }

  for (const artifact of task.artifacts as TaskArtifact[]) {
    for (const part of artifact.parts) {
      if (part.kind === 'data' && part.data) {
        const data = part.data as Record<string, unknown>;
        if (data.signingUrl) result.signingUrl = data.signingUrl as string;
        if (data.requestId) result.requestId = data.requestId as string;
      }
    }
  }

  return result;
}
