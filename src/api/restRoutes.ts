import express, { type Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import type { TaskStore, Message, DataPart } from '../a2a/taskStore.js';
import type { TaskEventEmitter } from '../a2a/streaming.js';
import { CIRCUITS, type CircuitId } from '../config/circuits.js';
import { VERIFIER_ADDRESSES } from '../config/contracts.js';
import type { SigningRequestRecord } from '../signing/types.js';
import type { RedisClient } from '../redis/client.js';
import { computeSignalHash } from '../input/inputBuilder.js';
import type { Config } from '../config/index.js';
import type { PaymentFacilitator } from '../payment/facilitator.js';
import { storeProofResult, getProofResult } from '../redis/proofResultStore.js';
import { verifyOnChain } from '../prover/verifier.js';

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
  paymentFacilitator?: PaymentFacilitator;
}

interface Circuit {
  id: string;
  displayName: string;
  description: string;
  requiredInputs: readonly string[];
  verifierAddress: string | null;
}

interface GenerateProofRequestBody {
  circuitId?: CircuitId;
  scope?: string;
  address?: string;
  signature?: string;
  requestId?: string;
  countryList?: string[];
  isIncluded?: boolean;
}

interface TaskArtifact {
  id: string;
  mimeType: string;
  parts: Array<{ kind: string; text?: string; data?: unknown }>;
  metadata?: Record<string, unknown>;
}

/**
 * Wait for a task to reach a terminal state.
 * Used by REST endpoints to block until proof generation completes.
 */
function waitForTaskCompletion(
  taskId: string,
  taskStore: TaskStore,
  emitter: TaskEventEmitter,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      emitter.removeListener(`task:${taskId}`, listener);
      const task = await taskStore.getTask(taskId);
      if (task) {
        resolve(task);
      } else {
        reject(new Error('Task not found after timeout'));
      }
    }, timeoutMs);

    const listener = (event: { type: string; data: unknown }) => {
      if (event.type === 'task') {
        clearTimeout(timeout);
        emitter.removeListener(`task:${taskId}`, listener);
        resolve(event.data);
      }
    };

    emitter.on(`task:${taskId}`, listener);
  });
}

/**
 * Extract proof result from task artifacts.
 * Returns flat JSON object for REST API response.
 */
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

/**
 * Extract signing URL and requestId from task artifacts.
 */
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

export function createRestRoutes(deps: RestRoutesDeps): Router {
  const { taskStore, taskEventEmitter, redis, config } = deps;
  const router = express.Router();

  /**
   * GET /api/v1/circuits
   * Returns list of supported circuits with metadata
   */
  router.get('/circuits', (_req: Request, res: Response) => {
    const chainId = '84532'; // Base Sepolia
    const verifierMap = VERIFIER_ADDRESSES[chainId] || {};

    const circuits: Circuit[] = Object.entries(CIRCUITS).map(([id, circuit]) => ({
      id,
      displayName: circuit.displayName,
      description: circuit.description,
      requiredInputs: circuit.requiredInputs,
      verifierAddress: verifierMap[id] || null,
    }));

    res.json({ circuits });
  });

  /**
   * POST /api/v1/proofs
   * Generate a ZK proof (three modes: web signing, resume, direct)
   */
  router.post('/proofs', async (req: Request, res: Response) => {
    const body = req.body as GenerateProofRequestBody;

    const { circuitId, scope, address, signature, requestId, countryList, isIncluded } = body;

    // Validate required fields
    if (!circuitId) {
      res.status(400).json({ error: 'circuitId is required' });
      return;
    }

    if (!scope) {
      res.status(400).json({ error: 'scope is required' });
      return;
    }

    if (!(circuitId in CIRCUITS)) {
      res.status(400).json({ error: `Unknown circuit: ${circuitId}` });
      return;
    }

    // Validate country fields for country circuit
    if (circuitId === 'coinbase_country_attestation') {
      if (!countryList || countryList.length === 0) {
        res.status(400).json({ error: 'countryList is required for coinbase_country_attestation' });
        return;
      }
      if (isIncluded === undefined || isIncluded === null) {
        res.status(400).json({ error: 'isIncluded is required for coinbase_country_attestation' });
        return;
      }
    }

    try {
      // Mode 3: Resume with requestId (user already signed)
      if (requestId) {
        const key = `signing:${requestId}`;
        const data = await redis.get(key);

        if (!data) {
          res.status(400).json({ error: 'Invalid or expired requestId' });
          return;
        }

        const record: SigningRequestRecord = JSON.parse(data);

        if (record.status !== 'completed') {
          res.status(400).json({ error: `Signing request is ${record.status}. Wait for user to sign.` });
          return;
        }

        if (!record.signature || !record.address) {
          res.status(400).json({ error: 'Signing request is missing signature or address' });
          return;
        }

        // Create task with completed signature
        const skillParams: Record<string, unknown> = {
          address: record.address,
          signature: record.signature,
          scope,
          circuitId,
        };

        if (circuitId === 'coinbase_country_attestation') {
          skillParams.countryList = countryList;
          skillParams.isIncluded = isIncluded;
        }

        const userMessage: Message = {
          role: 'user',
          parts: [
            {
              kind: 'data',
              mimeType: 'application/json',
              data: { skill: 'generate_proof', ...skillParams },
            } as DataPart,
          ],
          timestamp: new Date().toISOString(),
        };

        const task = await taskStore.createTask('generate_proof', skillParams, userMessage);

        // Record payment if present
        if (deps.paymentFacilitator) {
          const paymentInfo = (req as any).x402Payment;
          if (paymentInfo) {
            try {
              await deps.paymentFacilitator.recordPayment({
                taskId: task.id,
                payerAddress: paymentInfo.payerAddress,
                amount: paymentInfo.amount,
                network: paymentInfo.network,
              });
            } catch (error) {
              console.error(`Failed to record payment for task ${task.id}:`, error);
            }
          }
        }

        const completedTask = await waitForTaskCompletion(task.id, taskStore, taskEventEmitter, 120000);
        const taskData = completedTask as any;

        if (taskData.status.state === 'failed') {
          const errorMsg =
            taskData.status.message?.parts?.[0]?.text || 'Proof generation failed';
          res.status(500).json({ error: errorMsg });
          return;
        }

        const proofData = extractProofFromTask(taskData);

        // Store proof result and generate verifyUrl
        let verifyUrl: string | undefined;
        let proofId: string | undefined;
        if (proofData.proof && proofData.publicInputs) {
          try {
            proofId = await storeProofResult(redis, {
              proof: proofData.proof,
              publicInputs: proofData.publicInputs,
              circuitId,
              nullifier: proofData.nullifier || '',
              signalHash: proofData.signalHash || '',
            });
            verifyUrl = `${config.a2aBaseUrl}/v/${proofId}`;
          } catch (err) {
            console.error('[REST] Failed to store proof result:', err);
          }
        }

        res.json({
          taskId: taskData.id,
          state: taskData.status.state,
          ...proofData,
          ...(proofId && { proofId }),
          ...(verifyUrl && { verifyUrl }),
        });
        return;
      }

      // Mode 1: Web signing (no address/signature provided)
      if (!address || !signature) {
        // Create signing request
        const signingRequestId = randomUUID();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 300000); // 5 minutes

        const signingRecord: SigningRequestRecord = {
          id: signingRequestId,
          scope,
          circuitId,
          status: 'pending',
          createdAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          ...(circuitId === 'coinbase_country_attestation' && {
            countryList,
            isIncluded,
          }),
        };

        const signingKey = `signing:${signingRequestId}`;
        await redis.set(signingKey, JSON.stringify(signingRecord), 'EX', 300);

        const signingUrl = `${config.a2aBaseUrl}/s/${signingRequestId}`;

        res.json({
          taskId: signingRequestId,
          state: 'input-required',
          signingUrl,
          requestId: signingRequestId,
          message: 'Please sign at the signing URL to continue',
        });
        return;
      }

      // Mode 2: Direct signing (address + signature provided)
      const skillParams: Record<string, unknown> = {
        address,
        signature,
        scope,
        circuitId,
      };

      if (circuitId === 'coinbase_country_attestation') {
        skillParams.countryList = countryList;
        skillParams.isIncluded = isIncluded;
      }

      const userMessage: Message = {
        role: 'user',
        parts: [
          {
            kind: 'data',
            mimeType: 'application/json',
            data: { skill: 'generate_proof', ...skillParams },
          } as DataPart,
        ],
        timestamp: new Date().toISOString(),
      };

      const task = await taskStore.createTask('generate_proof', skillParams, userMessage);

      // Record payment if present
      if (deps.paymentFacilitator) {
        const paymentInfo = (req as any).x402Payment;
        if (paymentInfo) {
          try {
            await deps.paymentFacilitator.recordPayment({
              taskId: task.id,
              payerAddress: paymentInfo.payerAddress,
              amount: paymentInfo.amount,
              network: paymentInfo.network,
            });
          } catch (error) {
            console.error(`Failed to record payment for task ${task.id}:`, error);
          }
        }
      }

      const completedTask = await waitForTaskCompletion(task.id, taskStore, taskEventEmitter, 120000);
      const taskData = completedTask as any;

      if (taskData.status.state === 'failed') {
        const errorMsg =
          taskData.status.message?.parts?.[0]?.text || 'Proof generation failed';
        res.status(500).json({ error: errorMsg });
        return;
      }

      const proofData = extractProofFromTask(taskData);

      // Store proof result and generate verifyUrl
      let verifyUrl: string | undefined;
      let proofId: string | undefined;
      if (proofData.proof && proofData.publicInputs) {
        try {
          proofId = await storeProofResult(redis, {
            proof: proofData.proof,
            publicInputs: proofData.publicInputs,
            circuitId,
            nullifier: proofData.nullifier || '',
            signalHash: proofData.signalHash || '',
          });
          verifyUrl = `${config.a2aBaseUrl}/v/${proofId}`;
        } catch (err) {
          console.error('[REST] Failed to store proof result:', err);
        }
      }

      res.json({
        taskId: taskData.id,
        state: taskData.status.state,
        ...proofData,
        ...(proofId && { proofId }),
        ...(verifyUrl && { verifyUrl }),
      });
    } catch (error) {
      console.error('Proof generation error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  /**
   * GET /api/v1/proofs/:taskId
   * Get task status
   */
  router.get('/proofs/:taskId', async (req: Request, res: Response) => {
    const { taskId } = req.params;

    try {
      const task = await taskStore.getTask(taskId);

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
   * Verify a ZK proof on-chain
   */
  router.post('/proofs/verify', async (req: Request, res: Response) => {
    const { circuitId, proof, publicInputs, chainId } = req.body as {
      circuitId?: CircuitId;
      proof?: string;
      publicInputs?: string[];
      chainId?: string;
    };

    if (!circuitId) {
      res.status(400).json({ error: 'circuitId is required' });
      return;
    }

    if (!proof) {
      res.status(400).json({ error: 'proof is required' });
      return;
    }

    if (!publicInputs || !Array.isArray(publicInputs)) {
      res.status(400).json({ error: 'publicInputs is required and must be an array' });
      return;
    }

    if (!(circuitId in CIRCUITS)) {
      res.status(400).json({ error: `Unknown circuit: ${circuitId}` });
      return;
    }

    try {
      const targetChainId = chainId || '84532';

      const skillParams: Record<string, unknown> = {
        circuitId,
        proof,
        publicInputs,
        chainId: targetChainId,
      };

      const userMessage: Message = {
        role: 'user',
        parts: [
          {
            kind: 'data',
            mimeType: 'application/json',
            data: { skill: 'verify_proof', ...skillParams },
          } as DataPart,
        ],
        timestamp: new Date().toISOString(),
      };

      const task = await taskStore.createTask('verify_proof', skillParams, userMessage);
      const completedTask = await waitForTaskCompletion(task.id, taskStore, taskEventEmitter, 120000);
      const taskData = completedTask as any;

      if (taskData.status.state === 'failed') {
        const errorMsg =
          taskData.status.message?.parts?.[0]?.text || 'Verification failed';
        res.status(500).json({ error: errorMsg });
        return;
      }

      const verifierMap = VERIFIER_ADDRESSES[targetChainId] || {};
      const verifierAddress = verifierMap[circuitId] || null;

      if (!taskData.artifacts || taskData.artifacts.length === 0) {
        res.status(500).json({ error: 'No verification result returned' });
        return;
      }

      let valid = false;
      let errorMsg: string | undefined;

      for (const artifact of taskData.artifacts as TaskArtifact[]) {
        for (const part of artifact.parts) {
          if (part.kind === 'data' && part.data) {
            const data = part.data as Record<string, unknown>;
            if (typeof data.valid === 'boolean') {
              valid = data.valid;
            }
            if (data.error) {
              errorMsg = data.error as string;
            }
          }
        }
      }

      res.json({
        valid,
        circuitId,
        verifierAddress,
        chainId: targetChainId,
        ...(errorMsg ? { error: errorMsg } : {}),
      });
    } catch (error) {
      console.error('Verification error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  /**
   * GET /api/v1/verify/:proofId
   * Verify a stored proof on-chain by proofId (QR code / link verification)
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

  return router;
}
