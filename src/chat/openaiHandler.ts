import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { LLMMessage } from './llmProvider.js';
import { CHAT_TOOLS } from './tools.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';
import { executeSkill, PaymentRequiredError, type ChatHandlerDeps } from './chatHandler.js';

const MAX_FUNCTION_CALLS = 3;
const MODEL_NAME = 'zkproofport';

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

interface ProofportExtension {
  skillResult?: unknown;
  signingUrl?: string;
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

async function runChatLoop(
  history: LLMMessage[],
  systemPrompt: string,
  deps: ChatHandlerDeps,
  paymentVerified: boolean,
): Promise<{ response: string; extension?: ProofportExtension }> {
  let functionCallCount = 0;
  let proofCallCount = 0;
  let finalResponse: string | undefined;
  let lastSkillResult: unknown;
  let signingUrl: string | undefined;

  while (functionCallCount < MAX_FUNCTION_CALLS) {
    const llmResponse = await deps.llmProvider.chat(history, systemPrompt, CHAT_TOOLS);

    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      functionCallCount++;
      history.push({ role: 'assistant', toolCalls: llmResponse.toolCalls, content: llmResponse.content });

      const toolResults: Array<{ name: string; result: unknown }> = [];

      for (const tc of llmResponse.toolCalls) {
        let skillResult: unknown;

        if (tc.name === 'generate_proof' || tc.name === 'verify_proof') {
          if (proofCallCount >= 1) {
            skillResult = { error: 'Only one proof operation allowed per request. Please send a new message.' };
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

      history.push({ role: 'user', toolResults });
      continue;
    }

    if (llmResponse.content) {
      finalResponse = llmResponse.content;
    }

    history.push({ role: 'assistant', content: llmResponse.content || '' });
    break;
  }

  if (functionCallCount >= MAX_FUNCTION_CALLS && !finalResponse) {
    finalResponse = 'I apologize, but I reached the maximum number of function calls. Please try again.';
  }

  if (!finalResponse) {
    finalResponse = 'I apologize, but I was unable to generate a response.';
  }

  const extension: ProofportExtension = {};
  if (lastSkillResult !== undefined) extension.skillResult = lastSkillResult;
  if (signingUrl) extension.signingUrl = signingUrl;

  return {
    response: finalResponse,
    extension: Object.keys(extension).length > 0 ? extension : undefined,
  };
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

      const { systemPrompt, history } = convertMessages(body.messages);
      const completionId = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = body.model || MODEL_NAME;
      const paymentVerified = !!(req as any).paymentVerified;

      // Run chat loop BEFORE setting up SSE (allows 402 return before streaming starts)
      const { response, extension } = await runChatLoop(history, systemPrompt, deps, paymentVerified);

      if (body.stream) {
        // SSE streaming response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Send initial role chunk
        res.write(`data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })}\n\n`);

        // Stream content word by word
        const words = response.split(/(\s+)/);
        for (const word of words) {
          if (!word) continue;
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
          })}\n\n`);
        }

        // Send final chunk with finish_reason
        const finalChunk: Record<string, unknown> = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        if (extension) {
          finalChunk.x_proofport = extension;
        }
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        // Non-streaming response
        const completionResponse: Record<string, unknown> = {
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
        };

        if (extension) {
          completionResponse.x_proofport = extension;
        }

        res.json(completionResponse);
      }
    } catch (error) {
      if (error instanceof PaymentRequiredError && deps.paymentRequiredHeader) {
        res.setHeader('PAYMENT-REQUIRED', deps.paymentRequiredHeader);
        res.status(402).json({
          error: {
            message: 'Payment required for proof generation. Retry with PAYMENT-SIGNATURE header.',
            type: 'payment_required',
            code: 'payment_required',
          },
        });
        return;
      }
      console.error('[OpenAI] Error:', error);
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
