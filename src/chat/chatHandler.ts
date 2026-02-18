import { Router } from 'express';
import { randomUUID, randomBytes, createHash } from 'crypto';
import type { RedisClient } from '../redis/client.js';
import type { TaskStore } from '../a2a/taskStore.js';
import type { TaskEventEmitter } from '../a2a/streaming.js';
import type { LLMProvider, LLMMessage } from './llmProvider.js';
import { CHAT_TOOLS } from './tools.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { getSupportedCircuits } from '../mcp/tools/getCircuits.js';
import type { SigningRequestRecord } from '../signing/types.js';

export class PaymentRequiredError extends Error {
  constructor() {
    super('Payment required for proof generation');
    this.name = 'PaymentRequiredError';
  }
}

interface ChatRequest {
  message: string;
  sessionId?: string;
  sessionSecret?: string;
}

interface ChatResponse {
  response: string;
  sessionId: string;
  sessionSecret?: string;
  skillResult?: unknown;
  signingUrl?: string;
}

interface SessionData {
  secretHash: string;
  history: LLMMessage[];
}

export interface ChatHandlerDeps {
  redis: RedisClient;
  taskStore: TaskStore;
  taskEventEmitter: TaskEventEmitter;
  a2aBaseUrl: string;
  llmProvider: LLMProvider;
  paymentRequiredHeader?: string | null;
}

const MAX_FUNCTION_CALLS = 3;
const SESSION_TTL_SECONDS = 3600;
const MAX_HISTORY_MESSAGES = 20;

export function createChatRoutes(deps: ChatHandlerDeps): Router {
  const router = Router();

  router.post('/chat', async (req, res) => {
    try {
      const { message, sessionId: providedSessionId, sessionSecret: providedSecret } = req.body as ChatRequest;

      if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'Missing or invalid message field' });
        return;
      }

      const isNewSession = !providedSessionId;
      const sessionId = providedSessionId || randomUUID();
      const sessionKey = `chat:session:${sessionId}`;

      let history: LLMMessage[];
      let sessionSecret: string | undefined;
      let secretHash: string;

      if (isNewSession) {
        sessionSecret = randomBytes(32).toString('hex');
        secretHash = createHash('sha256').update(sessionSecret).digest('hex');
        history = [];
      } else {
        if (!providedSecret) {
          res.status(401).json({ error: 'sessionSecret is required to continue a session' });
          return;
        }

        const sessionDataRaw = await deps.redis.get(sessionKey);
        if (!sessionDataRaw) {
          res.status(404).json({ error: 'Session not found or expired' });
          return;
        }

        const sessionData: SessionData = JSON.parse(sessionDataRaw);
        const providedHash = createHash('sha256').update(providedSecret).digest('hex');

        if (providedHash !== sessionData.secretHash) {
          res.status(403).json({ error: 'Invalid sessionSecret' });
          return;
        }

        secretHash = sessionData.secretHash;
        history = sessionData.history;
      }

      // Add user message to history
      history.push({ role: 'user', content: message });

      let functionCallCount = 0;
      let proofCallCount = 0;
      let finalResponse: string | undefined;
      let lastSkillResult: unknown;
      let signingUrl: string | undefined;
      const paymentVerified = !!(req as any).paymentVerified;

      // Function calling loop
      while (functionCallCount < MAX_FUNCTION_CALLS) {
        const llmResponse = await deps.llmProvider.chat(history, SYSTEM_PROMPT, CHAT_TOOLS);

        // Check if model returned tool calls
        if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
          functionCallCount++;

          // Add assistant message with tool calls to history
          history.push({ role: 'assistant', toolCalls: llmResponse.toolCalls, content: llmResponse.content });

          const toolResults: Array<{ name: string; result: unknown }> = [];

          for (const tc of llmResponse.toolCalls) {
            let skillResult: unknown;

            // Limit proof operations to 1 per chat request
            if (tc.name === 'generate_proof' || tc.name === 'verify_proof') {
              if (proofCallCount >= 1) {
                skillResult = { error: 'Only one proof operation allowed per chat request. Please send a new message.' };
              } else {
                proofCallCount++;
                skillResult = await executeSkill(tc.name, tc.args, deps, paymentVerified);
              }
            } else {
              skillResult = await executeSkill(tc.name, tc.args, deps);
            }

            lastSkillResult = skillResult;

            if (typeof skillResult === 'object' && skillResult !== null && 'signingUrl' in skillResult) {
              signingUrl = (skillResult as { signingUrl: string }).signingUrl;
            }

            toolResults.push({ name: tc.name, result: skillResult });
          }

          // Add tool results to history
          history.push({ role: 'user', toolResults });

          // Continue loop to get text response
          continue;
        }

        // No tool calls — extract text response
        if (llmResponse.content) {
          finalResponse = llmResponse.content;
        }

        // Add assistant text to history
        history.push({ role: 'assistant', content: llmResponse.content || '' });

        // Exit loop
        break;
      }

      if (functionCallCount >= MAX_FUNCTION_CALLS && !finalResponse) {
        finalResponse = 'I apologize, but I reached the maximum number of function calls. Please try again.';
      }

      if (!finalResponse) {
        finalResponse = 'I apologize, but I was unable to generate a response.';
      }

      // Keep only last N messages to prevent context overflow
      const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);

      // Save updated conversation history to Redis
      const sessionDataToSave: SessionData = {
        secretHash,
        history: trimmedHistory,
      };

      await deps.redis.set(sessionKey, JSON.stringify(sessionDataToSave), 'EX', SESSION_TTL_SECONDS);

      const response: ChatResponse = {
        response: finalResponse,
        sessionId,
      };

      if (sessionSecret) {
        response.sessionSecret = sessionSecret;
      }

      if (lastSkillResult !== undefined) {
        response.skillResult = lastSkillResult;
      }

      if (signingUrl) {
        response.signingUrl = signingUrl;
      }

      res.json(response);
    } catch (error) {
      if (error instanceof PaymentRequiredError && deps.paymentRequiredHeader) {
        res.setHeader('PAYMENT-REQUIRED', deps.paymentRequiredHeader);
        res.status(402).json({
          error: 'Payment required',
          paymentRequired: true,
          description: 'Proof generation requires x402 USDC payment. Retry with PAYMENT-SIGNATURE header.',
        });
        return;
      }
      console.error('[Chat] Error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: `Chat failed: ${errorMessage}` });
    }
  });

  return router;
}

export async function createAndPollTask(
  skillName: string,
  skillParams: Record<string, unknown>,
  deps: ChatHandlerDeps
): Promise<unknown> {
  const userMessage = {
    role: 'user' as const,
    parts: [
      {
        kind: 'data' as const,
        mimeType: 'application/json',
        data: { skill: skillName, params: skillParams },
      },
    ],
  };

  const task = await deps.taskStore.createTask(skillName, skillParams, userMessage);
  deps.taskEventEmitter.emit('task.created', task);

  const maxWaitMs = 5 * 60 * 1000;
  const pollIntervalMs = 500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const updatedTask = await deps.taskStore.getTask(task.id);

    if (!updatedTask) {
      throw new Error('Task disappeared during execution');
    }

    if (updatedTask.status.state === 'completed') {
      if (updatedTask.artifacts && updatedTask.artifacts.length > 0) {
        const artifact = updatedTask.artifacts[0];
        if (artifact.parts && artifact.parts.length > 0) {
          const dataPart = artifact.parts.find(p => p.kind === 'data');
          if (dataPart && 'data' in dataPart) {
            return dataPart.data;
          }
        }
      }

      if (updatedTask.status.message) {
        return updatedTask.status.message;
      }

      return { status: 'completed' };
    }

    if (updatedTask.status.state === 'failed') {
      const errorMsg = updatedTask.status.message?.parts?.[0];
      const errorText = errorMsg && 'text' in errorMsg ? errorMsg.text : 'Unknown error';
      throw new Error(`Task failed: ${errorText}`);
    }

    if (updatedTask.status.state === 'rejected') {
      throw new Error('Task was rejected');
    }

    if (updatedTask.status.state === 'canceled') {
      throw new Error('Task was canceled');
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error('Task execution timeout');
}

export async function executeSkill(
  skillName: string,
  args: Record<string, unknown>,
  deps: ChatHandlerDeps,
  paymentVerified = false,
): Promise<unknown> {
  if (skillName === 'get_supported_circuits') {
    return getSupportedCircuits();
  }

  if (skillName === 'generate_proof') {
    const { circuitId, scope, address, signature, requestId, countryList, isIncluded } = args;

    if (!address && !signature && !requestId) {
      const signingRequestId = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 300000);

      const signingRecord: SigningRequestRecord = {
        id: signingRequestId,
        scope: scope as string,
        circuitId: circuitId as string,
        status: 'pending',
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };

      const signingKey = `signing:${signingRequestId}`;
      await deps.redis.set(signingKey, JSON.stringify(signingRecord), 'EX', 300);

      const signingUrl = `${deps.a2aBaseUrl}/s/${signingRequestId}`;

      return {
        state: 'input-required',
        signingUrl,
        requestId: signingRequestId,
        message: 'Please open the signing URL to connect your wallet and sign.',
      };
    }

    if (requestId) {
      const key = `signing:${requestId}`;
      const data = await deps.redis.get(key);
      if (!data) throw new Error('Invalid or expired requestId');

      const record: SigningRequestRecord = JSON.parse(data);
      if (record.status !== 'completed') {
        return { state: 'waiting', message: `Signing is ${record.status}. Please complete signing first.` };
      }
      if (!record.signature || !record.address) {
        throw new Error('Signing request missing signature or address');
      }

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

      if (!paymentVerified && deps.paymentRequiredHeader) {
        throw new PaymentRequiredError();
      }
      return await createAndPollTask(skillName, skillParams, deps);
    }

    const skillParams: Record<string, unknown> = { address, signature, scope, circuitId };
    if (circuitId === 'coinbase_country_attestation') {
      skillParams.countryList = countryList;
      skillParams.isIncluded = isIncluded;
    }
    if (!paymentVerified && deps.paymentRequiredHeader) {
      throw new PaymentRequiredError();
    }
    return await createAndPollTask(skillName, skillParams, deps);
  }

  if (skillName === 'verify_proof') {
    return await createAndPollTask(skillName, args, deps);
  }

  throw new Error(`Unknown skill: ${skillName}`);
}
