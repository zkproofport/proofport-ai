import { randomUUID } from 'crypto';
import { TaskStore, type A2aTask, type Artifact, type Message } from './taskStore.js';
import { TaskEventEmitter } from './streaming.js';
import type { Config } from '../config/index.js';
import { ethers } from 'ethers';
import { handleProofCompleted } from '../identity/reputation.js';
import type { TeeProvider } from '../tee/types.js';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  handleRequestSigning,
  handleCheckStatus,
  handleRequestPayment,
  handleGenerateProof,
  handleVerifyProof,
  handleGetSupportedCircuits,
  type SkillDeps,
} from '../skills/skillHandler.js';

const tracer = trace.getTracer('a2a-worker');

export class TaskWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private processing = false;

  constructor(
    private deps: {
      taskStore: TaskStore;
      taskEventEmitter: TaskEventEmitter;
      config: Config;
      teeProvider?: TeeProvider;
    }
  ) {}

  start(): void {
    if (this.intervalId) {
      console.log('TaskWorker already running');
      return;
    }

    console.log('TaskWorker starting...');
    this.intervalId = setInterval(() => {
      this.pollAndProcess().catch((error) => {
        console.error('TaskWorker polling error:', error);
      });
    }, 2000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('TaskWorker stopped');
    }
  }

  private async pollAndProcess(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      const redis = (this.deps.taskStore as any).redis;
      const taskId = await redis.rpop('a2a:queue:submitted');

      if (!taskId) {
        return;
      }

      const task = await this.deps.taskStore.getTask(taskId);

      if (!task) {
        console.warn(`Task ${taskId} not found in store`);
        return;
      }

      if (task.status.state !== 'queued') {
        console.warn(`Task ${taskId} is not in queued state (${task.status.state})`);
        return;
      }

      await this.processTask(task);
    } finally {
      this.processing = false;
    }
  }

  private buildSkillDeps(): SkillDeps {
    const redis = (this.deps.taskStore as any).redis;
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

  async processTask(task: A2aTask): Promise<void> {
    const { skill } = task;
    const span = tracer.startSpan('a2a.task.process');
    span.setAttribute('a2a.skill', skill);
    span.setAttribute('a2a.task_id', task.id);
    if (task.contextId) span.setAttribute('session_id', task.contextId);

    try {
      await this.deps.taskStore.updateTaskStatus(task.id, 'running');
      this.deps.taskEventEmitter.emitStatusUpdate(
        task.id,
        { state: 'running', timestamp: new Date().toISOString() },
        false
      );

      const skillDeps = this.buildSkillDeps();
      let result: unknown;

      switch (skill) {
        case 'request_signing':
          result = await handleRequestSigning(task.params as any, skillDeps);
          break;
        case 'check_status':
          result = await handleCheckStatus(task.params as any, skillDeps);
          break;
        case 'request_payment':
          result = await handleRequestPayment(task.params as any, skillDeps);
          break;
        case 'generate_proof':
          result = await handleGenerateProof(task.params as any, skillDeps);
          break;
        case 'verify_proof':
          result = await handleVerifyProof(task.params as any, skillDeps);
          break;
        case 'get_supported_circuits':
          result = handleGetSupportedCircuits(task.params as any);
          break;
        default:
          throw new Error(`Unknown skill: ${skill}`);
      }

      // Link contextId → requestId for session-based auto-resolution
      if (skill === 'request_signing' && task.contextId) {
        try {
          const requestId = (result as any)?.requestId;
          if (requestId) {
            await this.deps.taskStore.setContextFlow(task.contextId, requestId);
          }
        } catch (e) {
          console.error('[taskWorker] Failed to link context flow:', e);
        }
      }

      // Build artifact with result
      const artifact: Artifact = {
        id: randomUUID(),
        mimeType: 'application/json',
        parts: [
          { kind: 'text', text: `${skill} completed successfully.` },
          { kind: 'data', mimeType: 'application/json', data: result },
        ],
      };

      await this.deps.taskStore.addArtifact(task.id, artifact);
      const statusMsg: Message = {
        role: 'agent',
        parts: [{ kind: 'text', text: `${skill} completed successfully.` }],
        timestamp: new Date().toISOString(),
      };
      const updatedTask = await this.deps.taskStore.updateTaskStatus(task.id, 'completed', statusMsg);
      this.deps.taskEventEmitter.emitArtifactUpdate(task.id, artifact);
      this.deps.taskEventEmitter.emitStatusUpdate(
        task.id,
        { state: 'completed', message: statusMsg, timestamp: new Date().toISOString() },
        true
      );
      this.deps.taskEventEmitter.emitTaskComplete(task.id, updatedTask);

      // Increment reputation after successful proof (non-blocking)
      if (skill === 'generate_proof' && this.deps.config.erc8004ReputationAddress) {
        const provider = new ethers.JsonRpcProvider(this.deps.config.chainRpcUrl);
        const signer = new ethers.Wallet(this.deps.config.proverPrivateKey, provider);
        handleProofCompleted(
          {
            reputationContractAddress: this.deps.config.erc8004ReputationAddress,
            chainRpcUrl: this.deps.config.chainRpcUrl,
            privateKey: this.deps.config.proverPrivateKey,
          },
          signer.address
        ).catch((error) => {
          console.error('Background reputation update failed:', error);
        });
      }

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message || String(error) });
      console.error(`Task ${task.id} failed:`, error);
      const errorMessage = error.message || String(error);

      const errorArtifact: Artifact = {
        id: randomUUID(),
        mimeType: 'application/json',
        parts: [{ kind: 'text', text: errorMessage }],
      };
      await this.deps.taskStore.addArtifact(task.id, errorArtifact);
      this.deps.taskEventEmitter.emitArtifactUpdate(task.id, errorArtifact);

      await this.deps.taskStore.updateTaskStatus(task.id, 'failed', {
        role: 'agent',
        parts: [{ kind: 'text', text: errorMessage }],
        timestamp: new Date().toISOString(),
      });
      this.deps.taskEventEmitter.emitStatusUpdate(
        task.id,
        { state: 'failed', timestamp: new Date().toISOString() },
        true
      );
      const failedTask = await this.deps.taskStore.getTask(task.id);
      if (failedTask) {
        this.deps.taskEventEmitter.emitTaskComplete(task.id, failedTask);
      }
    } finally {
      span.end();
    }
  }
}
