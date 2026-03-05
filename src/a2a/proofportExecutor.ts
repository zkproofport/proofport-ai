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
// import {
//   handleRequestSigning,
//   handleCheckStatus,
//   handleRequestPayment,
//   handleGenerateProof,
//   handleVerifyProof,
//   handleGetSupportedCircuits,
//   type SkillDeps,
// } from '../skills/skillHandler.js';
import { handleGetSupportedCircuits, type SkillDeps } from '../skills/skillHandler.js';
import { handleProofCompleted } from '../identity/reputation.js';
import { getTaskOutcome } from '../skills/flowGuidance.js';
import type { LLMProvider } from '../chat/llmProvider.js';
import type { LLMTool } from '../chat/llmProvider.js';
import type { Config } from '../config/index.js';

/** Tool definitions for LLM-based skill routing in A2A text inference. */
export const A2A_TOOLS: LLMTool[] = [
  {
    name: 'prove',
    description: 'Submit proof inputs to generate a ZK proof via x402 single-step flow. Use POST /api/v1/prove REST endpoint for actual execution.',
    parameters: {
      type: 'object',
      properties: {
        circuit: { type: 'string', description: 'Circuit alias: "coinbase_kyc" or "coinbase_country"' },
      },
      required: ['circuit'],
    },
  },
  {
    name: 'get_supported_circuits',
    description: 'List all supported ZK circuits with metadata and verifier addresses.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_guide',
    description: 'Get comprehensive step-by-step guide for preparing all inputs for a specific circuit. Read this BEFORE attempting proof generation.',
    parameters: {
      type: 'object',
      properties: {
        circuit: { type: 'string', description: 'Circuit alias: "coinbase_kyc" or "coinbase_country"' },
      },
      required: ['circuit'],
    },
  },
];
import type { TeeProvider } from '../tee/types.js';
import type { RedisTaskStore } from './redisTaskStore.js';

const tracer = trace.getTracer('a2a-executor');

const VALID_SKILLS = ['prove', 'get_supported_circuits', 'get_guide'];

export const A2A_INFERENCE_PROMPT = `You are a skill router for proveragent.base.eth — a ZK proof generation agent for Coinbase KYC and country-of-residence verification. Given user text, determine which tool to call and extract parameters. ALWAYS respond with a tool call — never with plain text.

Available tools:
- prove: User wants to generate a ZK proof. Keywords: prove, generate proof, KYC proof, coinbase proof, verify identity, country proof, attestation, submit inputs, 증명 생성, 시작, KYC 검증, 나라 증명, 제출, 완료. Requires: circuit type (coinbase_kyc or coinbase_country).
- get_supported_circuits: User asks about available circuits or capabilities. Keywords: what circuits, list, supported, available, what can you do, 뭐 할 수 있어, 어떤 증명, 목록.
- get_guide: User wants to see the guide/instructions for preparing proof inputs. Keywords: guide, how to, instructions, steps, tutorial, help, 가이드, 방법, 어떻게.

CRITICAL RULES:
- NEVER guess or fabricate wallet addresses
- If the user doesn't provide the circuit type, ask them — do NOT make up values
- "Coinbase KYC" or just "KYC" → circuit = "coinbase_kyc"
- "country" or "residency" → circuit = "coinbase_country"
- The flow is x402 single-step: POST /api/v1/prove with circuit+inputs → 402 → pay → retry with X-Payment-TX/X-Payment-Nonce headers`;

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

async function inferSkillFromText(text: string, llmProvider: LLMProvider, logContext?: Record<string, string>): Promise<{ skill: string; params: Record<string, unknown> }> {
  const timeoutMs = 30000;
  const response = await Promise.race([
    llmProvider.chat(
      [{ role: 'user', content: text }],
      A2A_INFERENCE_PROMPT,
      A2A_TOOLS,
      { toolChoice: 'required', logContext },
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
  logContext?: Record<string, string>,
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

  const result = await inferSkillFromText(textContent, llmProvider, logContext);
  return { ...result, source: 'text' };
}

export class ProofportExecutor implements AgentExecutor {
  constructor(private deps: ExecutorDeps) {}

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const span = tracer.startSpan('a2a.task.process');
    span.setAttribute('a2a.task_id', ctx.taskId);
    span.setAttribute('a2a.context_id', ctx.contextId);

    let resolvedSkill: string | undefined;
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

      const logContext: Record<string, string> = { contextId: ctx.contextId, step: 'skill_resolution' };
      const { skill, params: skillParams, source } = await resolveSkill(ctx.userMessage, this.deps.llmProvider, logContext);
      resolvedSkill = skill;
      log.info({ action: 'a2a.skill.resolved', skill, source, contextId: ctx.contextId }, 'Resolved skill');
      log.debug({ action: 'a2a.skill.params', skill, params: skillParams, contextId: ctx.contextId }, 'Skill params');

      if (!VALID_SKILLS.includes(skill)) {
        throw new Error(`Invalid skill: ${skill}. Valid skills: ${VALID_SKILLS.join(', ')}`);
      }

      span.setAttribute('a2a.skill', skill);

      // Context flow tracking is no longer needed (session flow removed)

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
        case 'prove': {
          // For prove, redirect to REST endpoint since A2A has timeout limitations
          const circuitAlias = (skillParams as any).circuit || 'coinbase_kyc';
          const guideUrl = `${this.deps.config.a2aBaseUrl}/api/v1/guide/${circuitAlias}`;
          result = {
            message: 'Proof generation requires the REST API endpoint due to 30-90 second processing time. Use the x402 single-step flow: POST with {circuit, inputs} → 402 with nonce → pay → retry with X-Payment-TX and X-Payment-Nonce headers.',
            endpoint: `${this.deps.config.a2aBaseUrl}/api/v1/prove`,
            method: 'POST',
            guide_url: guideUrl,
            body_format: {
              circuit: 'string ("coinbase_kyc" or "coinbase_country")',
              inputs: {
                signal_hash: 'string (0x-prefixed 32-byte signal hash)',
                nullifier: 'string (0x-prefixed 32-byte nullifier)',
                scope_bytes: 'string (0x-prefixed 32-byte keccak256 of scope string)',
                merkle_root: 'string (0x-prefixed 32-byte Merkle root)',
                user_address: 'string (0x-prefixed 20-byte wallet address)',
                signature: 'string (eth_sign(signal_hash), 65 bytes hex)',
                user_pubkey_x: 'string (32 bytes hex)',
                user_pubkey_y: 'string (32 bytes hex)',
                raw_transaction: 'string (RLP-encoded, zero-padded to 300 bytes)',
                tx_length: 'number (actual byte length)',
                coinbase_attester_pubkey_x: 'string (32 bytes hex)',
                coinbase_attester_pubkey_y: 'string (32 bytes hex)',
                merkle_proof: 'string[] (each 32 bytes hex, max depth 8)',
                leaf_index: 'number',
                depth: 'number',
              },
            },
          };
          break;
        }
        case 'get_supported_circuits': {
          const circuitsResult = handleGetSupportedCircuits(skillParams as any, this.deps.config.paymentMode);
          const aliasMap: Record<string, string> = {
            coinbase_attestation: 'coinbase_kyc',
            coinbase_country_attestation: 'coinbase_country',
          };
          result = {
            ...circuitsResult,
            circuits: circuitsResult.circuits.map(circuit => ({
              ...circuit,
              guide_url: `${this.deps.config.a2aBaseUrl}/api/v1/guide/${aliasMap[circuit.id] ?? circuit.id}`,
            })),
          };
          break;
        }
        case 'get_guide': {
          const circuitAlias = (skillParams as any).circuit || 'coinbase_kyc';
          const circuitIdMap: Record<string, string> = {
            coinbase_kyc: 'coinbase_attestation',
            coinbase_country: 'coinbase_country_attestation',
          };
          const circuitId = circuitIdMap[circuitAlias] || circuitAlias;
          const { buildGuide } = await import('../proof/guideBuilder.js');
          result = buildGuide(circuitId as any, this.deps.config);
          break;
        }
        default:
          throw new Error(`Unknown skill: ${skill}`);
      }

      // Determine task state and guidance text
      let outcome;
      try {
        outcome = getTaskOutcome(skill, result);
      } catch {
        outcome = { guidance: JSON.stringify(result, null, 2), state: 'completed' as const };
      }

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
      if (skill === 'prove' && this.deps.config.erc8004ReputationAddress) {
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
          log.error({ action: 'a2a.reputation.failed', err: error }, 'Background reputation update failed');
        });
      }

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message || String(error) });
      log.error({ action: 'a2a.task.failed', err: error, taskId: ctx.taskId, contextId: ctx.contextId, skill: resolvedSkill }, 'Task failed');

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
