import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID, randomBytes, createHash } from 'crypto';
import type { LLMMessage } from './llmProvider.js';
import { CHAT_TOOLS } from './tools.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { executeSkill, type ChatHandlerDeps } from './chatHandler.js';
import { createLogger } from '../logger.js';

const log = createLogger('OpenAI');

const MAX_FUNCTION_CALLS = 5;
const MODEL_NAME = 'zkproofport';
const SESSION_TTL_SECONDS = 3600;
const MAX_HISTORY_MESSAGES = 50;

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
}

interface ChatCompletionRequest {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface SessionData {
  secretHash: string;
  history: LLMMessage[];
}

/**
 * Boundary-aware history trimming that preserves tool call/result pairs.
 * Skips orphaned tool results and incomplete tool call sequences when rolling.
 */
function trimHistory(history: LLMMessage[], maxMessages: number): LLMMessage[] {
  if (history.length <= maxMessages) return history;

  let startIdx = history.length - maxMessages;

  // Walk forward to find a safe boundary — skip orphaned tool results
  while (startIdx < history.length) {
    const msg = history[startIdx];
    // tool results need a preceding assistant(toolCalls) — skip them
    if (msg.role === 'user' && msg.toolResults && msg.toolResults.length > 0) {
      startIdx++;
      continue;
    }
    // assistant with toolCalls needs its following tool results — skip it too
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      startIdx++;
      continue;
    }
    break;
  }

  return history.slice(startIdx);
}

function convertMessages(messages: OpenAIMessage[]): { systemPrompt: string; history: LLMMessage[] } {
  let systemPrompt = SYSTEM_PROMPT;
  const history: LLMMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt = `${SYSTEM_PROMPT}\n\n${msg.content || ''}`;
    } else if (msg.role === 'user') {
      history.push({ role: 'user', content: msg.content || '' });
    } else if (msg.role === 'assistant') {
      history.push({ role: 'assistant', content: msg.content || '' });
    }
  }

  return { systemPrompt, history };
}

/**
 * Build proofport DSL extension block from skill result.
 * Filters raw proof data, keeps only summary fields + QR URLs.
 */
function buildDslBlock(lastSkillResult: unknown, signingUrl: string | undefined): string {
  const extension: Record<string, unknown> = {};

  if (lastSkillResult !== undefined) {
    if (typeof lastSkillResult === 'object' && lastSkillResult !== null) {
      const sr = lastSkillResult as Record<string, unknown>;
      const filtered: Record<string, unknown> = {};
      const SUMMARY_FIELDS = [
        'state', 'proofId', 'verifyUrl', 'paymentReceiptUrl', 'paymentTxHash',
        'nullifier', 'signalHash', 'signingUrl', 'requestId',
        'amount', 'network', 'message', 'error', 'valid',
        'circuitId', 'verifierAddress', 'verifierExplorerUrl', 'chainId',
      ];
      for (const key of SUMMARY_FIELDS) {
        if (sr[key] !== undefined) filtered[key] = sr[key];
      }

      if (sr.verifyUrl) {
        filtered.qrImageUrl = `https://quickchart.io/qr?text=${encodeURIComponent(sr.verifyUrl as string)}&size=300&dark=4ade80&light=1a1a1a`;
      }
      if (sr.paymentReceiptUrl) {
        filtered.receiptQrImageUrl = `https://quickchart.io/qr?text=${encodeURIComponent(sr.paymentReceiptUrl as string)}&size=300&dark=4ade80&light=1a1a1a`;
      }

      extension.skillResult = filtered;
    } else {
      extension.skillResult = lastSkillResult;
    }
  }
  if (signingUrl) extension.signingUrl = signingUrl;

  if (Object.keys(extension).length > 0) {
    return '\n\n```proofport\n' + JSON.stringify(extension, null, 2) + '\n```';
  }
  return '';
}

/**
 * Run the LLM chat loop with tool execution.
 * When onStream is provided, intermediate LLM content (step descriptions before tool calls)
 * and final content are streamed incrementally via the callback.
 * When onStep is provided, named SSE step events are emitted before/after tool execution.
 */
async function runChatLoop(
  history: LLMMessage[],
  systemPrompt: string,
  deps: ChatHandlerDeps,
  onStream?: (content: string) => void,
  onStep?: (step: { message: string }) => void,
): Promise<{ response: string }> {
  let functionCallCount = 0;
  let proofCallCount = 0;
  let finalResponse: string | undefined;
  let lastSkillResult: unknown;
  let signingUrl: string | undefined;

  while (functionCallCount < MAX_FUNCTION_CALLS) {
    const llmResponse = await deps.llmProvider.chat(history, systemPrompt, CHAT_TOOLS);

    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      functionCallCount++;

      // Stream intermediate content immediately (step descriptions before tool execution)
      if (llmResponse.content && onStream) {
        onStream(llmResponse.content);
      }

      history.push({ role: 'assistant', toolCalls: llmResponse.toolCalls, content: llmResponse.content });

      const toolResults: Array<{ id?: string; name: string; result: unknown }> = [];

      for (const tc of llmResponse.toolCalls) {
        // Emit BEFORE step
        if (onStep) {
          if (tc.name === 'generate_proof') {
            if (!tc.args.requestId) {
              onStep({ message: '⏳ Step 1/5: Generating signing URL...' });
            } else {
              onStep({ message: '⏳ Step 4/5: Generating proof (this may take 1-2 minutes)...' });
            }
          } else if (tc.name === 'verify_proof') {
            onStep({ message: '⏳ Verifying proof on-chain...' });
          } else if (tc.name === 'get_supported_circuits') {
            onStep({ message: '⏳ Fetching supported circuits...' });
          }
        }

        let skillResult: unknown;

        if (tc.name === 'generate_proof' || tc.name === 'verify_proof') {
          if (proofCallCount >= 1) {
            skillResult = { error: 'Only one proof operation allowed per request. Please send a new message.' };
          } else {
            proofCallCount++;
            skillResult = await executeSkill(tc.name, tc.args, deps);
          }
        } else {
          skillResult = await executeSkill(tc.name, tc.args, deps);
        }

        lastSkillResult = skillResult;

        if (typeof skillResult === 'object' && skillResult !== null && 'signingUrl' in skillResult) {
          signingUrl = (skillResult as { signingUrl: string }).signingUrl;
        }

        // Emit AFTER step based on result
        if (onStep) {
          if (tc.name === 'generate_proof') {
            const sr = skillResult as Record<string, unknown> | undefined;
            if (sr && typeof sr === 'object') {
              if (sr.state === 'input-required') {
                onStep({ message: '✅ Step 1/5: Signing URL generated' });
              } else if (sr.state === 'payment-required') {
                onStep({ message: '💳 Step 3/5: Payment required — $0.10 USDC' });
              } else if (sr.state === 'waiting') {
                onStep({ message: '⏳ Waiting for wallet signature...' });
              } else if (sr.proofId || sr.proof) {
                onStep({ message: '✅ Step 4/5: Proof generated successfully' });
              } else if (sr.error) {
                onStep({ message: `❌ Error: ${sr.error}` });
              }
            }
          } else if (tc.name === 'verify_proof') {
            const sr = skillResult as Record<string, unknown> | undefined;
            if (sr && typeof sr === 'object') {
              if (sr.valid === true) {
                onStep({ message: '✅ Step 5/5: Proof is valid on-chain' });
              } else if (sr.valid === false) {
                onStep({ message: '❌ Step 5/5: Proof verification failed' });
              } else {
                onStep({ message: '✅ Step 5/5: Verification complete' });
              }
            }
          } else if (tc.name === 'get_supported_circuits') {
            onStep({ message: '✅ Circuits retrieved' });
          }
        }

        toolResults.push({ id: tc.id, name: tc.name, result: skillResult });
      }

      history.push({ role: 'user', toolResults });
      continue;
    }

    // Final response (no tool calls)
    if (llmResponse.content) {
      finalResponse = llmResponse.content;
      if (onStream) {
        onStream(llmResponse.content);
      }
    }

    history.push({ role: 'assistant', content: llmResponse.content || '' });
    break;
  }

  if (functionCallCount >= MAX_FUNCTION_CALLS && !finalResponse) {
    finalResponse = 'I apologize, but I reached the maximum number of function calls. Please try again.';
    if (onStream) onStream(finalResponse);
  }

  if (!finalResponse) {
    finalResponse = 'I apologize, but I was unable to generate a response.';
    if (onStream) onStream(finalResponse);
  }

  // Build and stream DSL block
  const dslBlock = buildDslBlock(lastSkillResult, signingUrl);
  if (dslBlock) {
    if (onStream) onStream(dslBlock);
    finalResponse += dslBlock;
  }

  return { response: finalResponse };
}

export function createOpenAIRoutes(deps: ChatHandlerDeps): Router {
  const router = Router();

  // GET /v1/models — list available models
  router.get('/models', (_req, res) => {
    res.json({
      object: 'list',
      data: [
        {
          id: MODEL_NAME,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'zkproofport',
        },
      ],
    });
  });

  // POST /v1/chat/completions — OpenAI-compatible chat completions
  // Session management via X-Session-Id / X-Session-Secret HTTP headers
  router.post('/chat/completions', async (req: Request, res: Response) => {
    try {
      const body = req.body as ChatCompletionRequest;

      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        res.status(400).json({
          error: {
            message: 'messages is required and must be a non-empty array',
            type: 'invalid_request_error',
            code: 'invalid_messages',
          },
        });
        return;
      }

      const completionId = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = body.model || MODEL_NAME;

      // --- Session management (via HTTP headers) ---
      const providedSessionId = req.headers['x-session-id'] as string | undefined;
      const providedSecret = req.headers['x-session-secret'] as string | undefined;

      let history: LLMMessage[];
      let systemPrompt: string;
      let sessionId: string | undefined;
      let sessionSecret: string | undefined;
      let secretHash: string | undefined;

      if (providedSessionId) {
        // Continuing an existing session
        if (!providedSecret) {
          res.status(403).json({
            error: {
              message: 'X-Session-Secret header is required to continue a session',
              type: 'invalid_request_error',
              code: 'missing_session_secret',
            },
          });
          return;
        }

        const sessionKey = `chat:session:${providedSessionId}`;
        const sessionDataRaw = await deps.redis.get(sessionKey);
        if (!sessionDataRaw) {
          res.status(404).json({
            error: {
              message: 'Session not found or expired',
              type: 'invalid_request_error',
              code: 'session_not_found',
            },
          });
          return;
        }

        const sessionData: SessionData = JSON.parse(sessionDataRaw);
        const providedHash = createHash('sha256').update(providedSecret).digest('hex');

        if (providedHash !== sessionData.secretHash) {
          res.status(403).json({
            error: {
              message: 'Invalid session secret',
              type: 'invalid_request_error',
              code: 'invalid_session_secret',
            },
          });
          return;
        }

        // Load history from session, append only the LAST user message from messages array
        history = sessionData.history;
        secretHash = sessionData.secretHash;
        sessionId = providedSessionId;

        const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user');
        if (lastUserMsg) {
          history.push({ role: 'user', content: lastUserMsg.content || '' });
        }

        // Extract system prompt from messages if provided
        const systemMsg = body.messages.find(m => m.role === 'system');
        systemPrompt = systemMsg ? `${SYSTEM_PROMPT}\n\n${systemMsg.content || ''}` : SYSTEM_PROMPT;
      } else {
        // Stateless mode OR auto-create session
        const converted = convertMessages(body.messages);
        history = converted.history;
        systemPrompt = converted.systemPrompt;

        // Auto-create session if there's exactly 1 user message (first turn)
        const userMessages = body.messages.filter(m => m.role === 'user');
        if (userMessages.length === 1) {
          sessionId = randomUUID();
          sessionSecret = randomBytes(32).toString('hex');
          secretHash = createHash('sha256').update(sessionSecret).digest('hex');
        }
        // Otherwise: pure stateless, no session
      }

      // Set session headers ONCE before response body
      if (sessionId) res.setHeader('X-Session-Id', sessionId);
      if (sessionSecret) res.setHeader('X-Session-Secret', sessionSecret);

      const saveSession = async () => {
        if (sessionId && secretHash) {
          const rolledHistory = trimHistory(history, MAX_HISTORY_MESSAGES);
          const sessionDataToSave: SessionData = { secretHash, history: rolledHistory };
          const sessionKey = `chat:session:${sessionId}`;
          await deps.redis.set(sessionKey, JSON.stringify(sessionDataToSave), 'EX', SESSION_TTL_SECONDS);
        }
      };

      if (body.stream) {
        // Real SSE streaming — set up BEFORE running chat loop
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Helper to write an SSE content chunk
        const writeSseContent = (content: string) => {
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`);
        };

        // Send initial role chunk
        res.write(`data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })}\n\n`);

        // Heartbeat to keep connection alive during long tool executions
        const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 15000);

        try {
          // Stream callback: sends each LLM content piece as SSE chunks line-by-line
          const onStream = (content: string) => {
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              const chunk = i < lines.length - 1 ? lines[i] + '\n' : lines[i];
              if (chunk) writeSseContent(chunk);
            }
          };

          // Step callback: sends named SSE step events
          const onStep = (step: { message: string }) => {
            res.write(`event: step\ndata: ${JSON.stringify(step)}\n\n`);
          };

          await runChatLoop(history, systemPrompt, deps, onStream, onStep);
          await saveSession();

          // Send final chunk with finish_reason
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (error) {
          // Send error as SSE event (can't change HTTP status after headers flushed)
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: `\n\nError: ${errorMessage}` }, finish_reason: null }],
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } finally {
          clearInterval(heartbeat);
        }
      } else {
        // Non-streaming: run chat loop, then return complete response (no onStep)
        const { response } = await runChatLoop(history, systemPrompt, deps);
        await saveSession();

        res.json({
          id: completionId,
          object: 'chat.completion',
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: response,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        });
      }
    } catch (error) {
      log.error({ err: error }, 'Chat completion error');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: {
          message: `Chat completion failed: ${errorMessage}`,
          type: 'server_error',
          code: 'internal_error',
        },
      });
    }
  });

  return router;
}
