import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('A2A');
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';
import type {
  Task,
  Message,
  DataPart,
  TextPart,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  Artifact,
} from '@a2a-js/sdk';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { ethers } from 'ethers';
import {
  handleRequestSigning,
  handleCheckStatus,
  handleRequestPayment,
  handleGenerateProof,
  handleVerifyProof,
  handleGetSupportedCircuits,
  type SkillDeps,
} from '../skills/skillHandler.js';
import { handleProofCompleted } from '../identity/reputation.js';
import { getTaskOutcome } from '../skills/flowGuidance.js';
import type { LLMProvider } from '../chat/llmProvider.js';
import { CHAT_TOOLS } from '../chat/tools.js';
import type { Config } from '../config/index.js';
import type { TeeProvider } from '../tee/types.js';
import type { RedisTaskStore } from './redisTaskStore.js';

const tracer = trace.getTracer('a2a-executor');

const VALID_SKILLS = ['request_signing', 'check_status', 'request_payment', 'generate_proof', 'verify_proof', 'get_supported_circuits'];

export const A2A_INFERENCE_PROMPT = `You are a skill router for proveragent.base.eth. Given user text, determine which tool to call and extract parameters. ALWAYS respond with a tool call — never with plain text.

CRITICAL — requestId handling:
- The server automatically resolves requestId from the session context. You do NOT need to provide it.
- NEVER guess, fabricate, or use placeholder values like "YOUR_REQUEST_ID", "<request_id>", or "unknown".
- Only include requestId if the user explicitly provides a specific UUID value (e.g., "check status of abc-123").
- For follow-up messages like "done", "check status", "pay", "결제해줘" — call the tool WITHOUT requestId. The server fills it in.

Tool selection rules:
- verify_proof: User wants to VERIFY or VALIDATE an existing proof. Keywords: verify, validate, check proof, 검증, 확인, 검사. Often includes a hex proof value (0x...) or proofId. When the user provides a hex string and asks to verify/check it, ALWAYS use verify_proof.
- generate_proof: User wants to CREATE or GENERATE a new proof. Keywords: generate, create, make, prove, 생성, 만들어, 증명해.
- request_signing: User wants to initiate a signing request for proof generation (alternative entry point to generate_proof flow).
- get_supported_circuits: User asks about available circuits. Keywords: list, show, what circuits, which circuits, 목록, 지원, 뭐 있어, 어떤.
- check_status: User wants to check the status of an existing request. Keywords: status, progress, done yet, done, 상태, 완료됐어, 됐어, 확인.
- request_payment: User wants to pay for a proof request. Keywords: pay, payment, 결제, 지불.

Critical distinction — 검증 vs 생성: "검증해줘" = verify_proof. "생성해줘" = generate_proof. If the user provides a hex value (0x...) and uses words like 검증/확인/verify/validate, always route to verify_proof.

CRITICAL — generate_proof vs request_signing:
- generate_proof: Use when the user says "generate proof", "증명 생성", "make proof", "prove" as a FOLLOW-UP after signing/payment. If the user does NOT provide circuitId, scope, or address, they are asking to continue an existing session → use generate_proof. The server auto-resolves requestId, circuitId, and scope from the session.
- request_signing: Use ONLY when the user provides specific parameters (wallet address, circuitId, scope) to START a NEW proof session. If the user gives a wallet address and circuit type, use request_signing.
- When in doubt (no address, no circuitId given, just "증명 생성해줘" or "generate proof"), prefer generate_proof.`;

export interface ExecutorDeps {
  taskStore: RedisTaskStore;
  config: Config;
  teeProvider?: TeeProvider;
  llmProvider?: LLMProvider;
}

function extractSkillFromDataPart(message: Message): { skill: string; params: Record<string, unknown> } | null {
  for (const part of message.parts) {
    if (part.kind === 'data') {
      const data = (part as DataPart).data as Record<string, unknown>;
      if (data && typeof data.skill === 'string') {
        const { skill, ...params } = data;
        return { skill: skill as string, params };
      }
    }
  }
  return null;
}

async function inferSkillFromText(text: string, llmProvider: LLMProvider): Promise<{ skill: string; params: Record<string, unknown> }> {
  const timeoutMs = 30000;
  const response = await Promise.race([
    llmProvider.chat(
      [{ role: 'user', content: text }],
      A2A_INFERENCE_PROMPT,
      CHAT_TOOLS,
      { toolChoice: 'required' },
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('LLM inference timed out after 30 seconds')), timeoutMs),
    ),
  ]);

  if (response.toolCalls && response.toolCalls.length > 0) {
    const toolCall = response.toolCalls[0];
    return { skill: toolCall.name, params: toolCall.args };
  }

  throw new Error('Could not determine skill from message. The LLM did not return a tool call.');
}

async function resolveSkill(
  message: Message,
  llmProvider?: LLMProvider,
): Promise<{ skill: string; params: Record<string, unknown>; source: 'data' | 'text' }> {
  const dataPartResult = extractSkillFromDataPart(message);
  if (dataPartResult) {
    return { ...dataPartResult, source: 'data' };
  }

  const textContent = message.parts
    .filter((p): p is TextPart => p.kind === 'text')
    .map(p => p.text)
    .join(' ');

  if (!textContent.trim()) {
    throw new Error('Message contains no text or data parts');
  }

  if (!llmProvider) {
    throw new Error('Text inference requires LLM configuration. Use a DataPart with { "skill": "..." } for direct routing.');
  }

  const result = await inferSkillFromText(textContent, llmProvider);
  return { ...result, source: 'text' };
}

export class ProofportExecutor implements AgentExecutor {
  constructor(private deps: ExecutorDeps) {}

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const span = tracer.startSpan('a2a.task.process');
    span.setAttribute('a2a.task_id', ctx.taskId);
    span.setAttribute('a2a.context_id', ctx.contextId);

    try {
      // Publish initial Task event FIRST so the SDK ResultManager can track it.
      // This must happen before resolveSkill() because if resolveSkill throws,
      // the catch block needs ResultManager to have currentTask set.
      const initialTask: Task = ctx.task ?? {
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: 'submitted', timestamp: new Date().toISOString() },
        history: [ctx.userMessage],
        kind: 'task',
      };
      eventBus.publish(initialTask);

      const { skill, params: skillParams, source } = await resolveSkill(ctx.userMessage, this.deps.llmProvider);
      log.info({ skill, source, contextId: ctx.contextId }, 'Resolved skill');
      log.debug({ skill, params: skillParams }, 'Skill params');

      if (!VALID_SKILLS.includes(skill)) {
        throw new Error(`Invalid skill: ${skill}. Valid skills: ${VALID_SKILLS.join(', ')}`);
      }

      span.setAttribute('a2a.skill', skill);

      // Auto-resolve requestId from context flow.
      // For text-inferred skills, ALWAYS override requestId with context flow
      // because LLMs often hallucinate placeholder requestIds like "YOUR_REQUEST_ID".
      // For DataPart skills, only fill in if not explicitly provided.
      if (ctx.contextId) {
        try {
          const storedRequestId = await this.deps.taskStore.getContextFlow(ctx.contextId);
          if (storedRequestId && ['check_status', 'request_payment', 'generate_proof'].includes(skill)) {
            if (source === 'text' || !skillParams.requestId) {
              log.info({ requestId: storedRequestId, source, overridden: !!skillParams.requestId }, 'Auto-resolved requestId from context flow');
              skillParams.requestId = storedRequestId;
            }
          }
        } catch (e) {
          log.error({ err: e }, 'Failed to resolve context flow');
        }
      }

      // Publish working status
      eventBus.publish({
        kind: 'status-update',
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: 'working', timestamp: new Date().toISOString() },
        final: false,
      } as TaskStatusUpdateEvent);

      // Dispatch to skill handler
      const skillDeps = this.buildSkillDeps();
      let result: unknown;

      switch (skill) {
        case 'request_signing':
          result = await handleRequestSigning(skillParams as any, skillDeps);
          break;
        case 'check_status':
          result = await handleCheckStatus(skillParams as any, skillDeps);
          break;
        case 'request_payment':
          result = await handleRequestPayment(skillParams as any, skillDeps);
          break;
        case 'generate_proof':
          result = await handleGenerateProof(skillParams as any, skillDeps);
          break;
        case 'verify_proof':
          result = await handleVerifyProof(skillParams as any, skillDeps);
          break;
        case 'get_supported_circuits':
          result = handleGetSupportedCircuits(skillParams as any);
          break;
        default:
          throw new Error(`Unknown skill: ${skill}`);
      }

      // Link contextId -> requestId for session-based auto-resolution
      if (skill === 'request_signing' && ctx.contextId) {
        try {
          const requestId = (result as any)?.requestId;
          if (requestId) {
            // Only set context flow if no existing mapping (prevent accidental overwrite)
            const existingRequestId = await this.deps.taskStore.getContextFlow(ctx.contextId);
            if (!existingRequestId) {
              await this.deps.taskStore.setContextFlow(ctx.contextId, requestId);
            } else {
              log.info({ existingRequestId, newRequestId: requestId, contextId: ctx.contextId }, 'Context flow already exists, not overwriting');
            }
          }
        } catch (e) {
          log.error({ err: e }, 'Failed to link context flow');
        }
      }

      // Determine task state and guidance text
      const outcome = getTaskOutcome(skill, result);

      // Build artifact with context-specific guidance
      const artifact: Artifact = {
        artifactId: randomUUID(),
        parts: [
          { kind: 'text', text: outcome.guidance } as TextPart,
          { kind: 'data', data: result as Record<string, unknown> } as DataPart,
        ],
      };

      eventBus.publish({
        kind: 'artifact-update',
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        artifact,
        lastChunk: true,
      } as TaskArtifactUpdateEvent);

      // Publish final status with appropriate state
      eventBus.publish({
        kind: 'status-update',
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: outcome.state, timestamp: new Date().toISOString() },
        final: true,
      } as TaskStatusUpdateEvent);

      eventBus.finished();

      // ERC-8004 reputation (non-blocking)
      if (skill === 'generate_proof' && this.deps.config.erc8004ReputationAddress) {
        const provider = new ethers.JsonRpcProvider(this.deps.config.chainRpcUrl);
        const signer = new ethers.Wallet(this.deps.config.proverPrivateKey, provider);
        handleProofCompleted(
          {
            reputationContractAddress: this.deps.config.erc8004ReputationAddress,
            chainRpcUrl: this.deps.config.chainRpcUrl,
            privateKey: this.deps.config.proverPrivateKey,
          },
          signer.address,
        ).catch((error) => {
          log.error({ err: error }, 'Background reputation update failed');
        });
      }

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message || String(error) });
      log.error({ err: error, taskId: ctx.taskId }, 'Task failed');

      const errorMessage = error.message || String(error);

      // Publish error artifact
      const errorArtifact: Artifact = {
        artifactId: randomUUID(),
        parts: [{ kind: 'text', text: errorMessage } as TextPart],
      };

      eventBus.publish({
        kind: 'artifact-update',
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        artifact: errorArtifact,
        lastChunk: true,
      } as TaskArtifactUpdateEvent);

      // Publish failed status
      eventBus.publish({
        kind: 'status-update',
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: 'failed', timestamp: new Date().toISOString() },
        final: true,
      } as TaskStatusUpdateEvent);

      eventBus.finished();
    } finally {
      span.end();
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId: '',
      status: { state: 'canceled', timestamp: new Date().toISOString() },
      final: true,
    } as TaskStatusUpdateEvent);
    eventBus.finished();
  }

  private buildSkillDeps(): SkillDeps {
    const redis = this.deps.taskStore.redis;
    return {
      redis,
      signPageUrl: this.deps.config.signPageUrl || this.deps.config.a2aBaseUrl,
      signingTtlSeconds: this.deps.config.signingTtlSeconds || 300,
      paymentMode: this.deps.config.paymentMode,
      paymentProofPrice: this.deps.config.paymentProofPrice || '$0.10',
      easGraphqlEndpoint: this.deps.config.easGraphqlEndpoint,
      rpcUrls: [this.deps.config.baseRpcUrl],
      bbPath: this.deps.config.bbPath,
      nargoPath: this.deps.config.nargoPath,
      circuitsDir: this.deps.config.circuitsDir,
      chainRpcUrl: this.deps.config.chainRpcUrl,
      teeProvider: this.deps.teeProvider,
      teeMode: this.deps.config.teeMode,
    };
  }
}
