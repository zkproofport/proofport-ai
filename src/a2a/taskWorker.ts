import { randomUUID } from 'crypto';
import { TaskStore, type A2aTask, type Artifact } from './taskStore.js';
import { TaskEventEmitter } from './streaming.js';
import type { Config } from '../config/index.js';
import { BbProver } from '../prover/bbProver.js';
import { computeCircuitParams, computeSignalHash } from '../input/inputBuilder.js';
import { ethers } from 'ethers';
import { CIRCUITS } from '../config/circuits.js';
import { VERIFIER_ADDRESSES } from '../config/contracts.js';
import { handleProofCompleted } from '../identity/reputation.js';
import type { TeeProvider } from '../tee/types.js';
import type { SigningRequestRecord } from '../signing/types.js';

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

  async processTask(task: A2aTask): Promise<void> {
    const { skill } = task;

    try {
      if (skill === 'generate_proof') {
        await this.processGenerateProof(task);
      } else if (skill === 'verify_proof') {
        await this.processVerifyProof(task);
      } else if (skill === 'get_supported_circuits') {
        await this.processGetSupportedCircuits(task);
      } else {
        throw new Error(`Unknown skill: ${skill}`);
      }
    } catch (error: any) {
      console.error(`Task ${task.id} failed:`, error);
      const errorMessage = error.message || String(error);
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
    }
  }

  private async processGenerateProof(task: A2aTask): Promise<void> {
    const { params } = task;
    const emitter = this.deps.taskEventEmitter;

    await this.deps.taskStore.updateTaskStatus(task.id, 'running');
    emitter.emitStatusUpdate(
      task.id,
      { state: 'running', timestamp: new Date().toISOString() },
      false
    );

    const address = params.address as string | undefined;
    const signature = params.signature as string | undefined;
    const requestId = params.requestId as string | undefined;
    const scope = params.scope as string;
    const circuitId = params.circuitId as string;
    const countryList = params.countryList as string[] | undefined;
    const isIncluded = params.isIncluded as boolean | undefined;

    if (!scope || !circuitId) {
      throw new Error('Missing required parameters: scope, circuitId');
    }

    // ─── Resolve address + signature (3 modes) ─────────────────────────
    let resolvedAddress: string;
    let resolvedSignature: string;

    if (signature) {
      // Mode 1: Direct signature provided — address required
      if (!address) {
        throw new Error('Address is required when providing a signature directly.');
      }
      resolvedAddress = address;
      resolvedSignature = signature;
    } else if (requestId) {
      // Mode 3: Resume with requestId — get address + signature from Redis
      const redis = (this.deps.taskStore as any).redis;
      if (!redis) {
        throw new Error('Redis is required for web signing flow');
      }
      const key = `signing:${requestId}`;
      const data = await redis.get(key);
      if (!data) {
        throw new Error('Signing request not found or expired');
      }
      const record: SigningRequestRecord = JSON.parse(data);
      if (record.status !== 'completed' || !record.signature || !record.address) {
        throw new Error(
          `Signing request is not yet completed (status: ${record.status}). ` +
          `Please wait for the user to sign at the signing page.`
        );
      }
      resolvedAddress = record.address;
      resolvedSignature = record.signature;
      // Clean up used signing request
      await redis.del(key);
    } else {
      // Mode 2: No signature, no requestId — create web signing request
      if (!this.deps.config.signPageUrl) {
        throw new Error(
          'Web signing is not configured. Either provide a signature directly, ' +
          'or configure SIGN_PAGE_URL for web signing.'
        );
      }

      const redis = (this.deps.taskStore as any).redis;
      if (!redis) {
        throw new Error('Redis is required for web signing flow');
      }

      const newRequestId = randomUUID();
      const ttl = this.deps.config.signingTtlSeconds || 300;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttl * 1000);

      const record: SigningRequestRecord = {
        id: newRequestId,
        scope,
        circuitId,
        status: 'pending',
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };

      const key = `signing:${newRequestId}`;
      await redis.set(key, JSON.stringify(record), 'EX', ttl);

      const signingUrl = `${this.deps.config.signPageUrl.replace(/\/$/, '')}/s/${newRequestId}`;

      // Build artifact with awaiting_signature status
      const artifact: Artifact = {
        id: randomUUID(),
        mimeType: 'application/json',
        parts: [{
          kind: 'data',
          mimeType: 'application/json',
          data: {
            status: 'awaiting_signature',
            signingUrl,
            requestId: newRequestId,
            message:
              `Signature required. Please ask the user to open the signing URL and connect their wallet to sign. ` +
              `Then call generate_proof again with requestId: "${newRequestId}".`,
          },
        }],
      };

      await this.deps.taskStore.addArtifact(task.id, artifact);
      const updatedTask = await this.deps.taskStore.updateTaskStatus(task.id, 'completed');
      emitter.emitArtifactUpdate(task.id, artifact);
      emitter.emitStatusUpdate(
        task.id,
        { state: 'completed', timestamp: new Date().toISOString() },
        true
      );
      emitter.emitTaskComplete(task.id, updatedTask);
      return;
    }

    emitter.emitStatusUpdate(
      task.id,
      {
        state: 'running',
        message: {
          role: 'agent',
          parts: [{ kind: 'text', text: 'Constructing circuit parameters' }],
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      },
      false
    );

    const rpcUrls = [this.deps.config.baseRpcUrl];
    const circuitParams = await computeCircuitParams(
      {
        address: resolvedAddress,
        signature: resolvedSignature,
        scope,
        circuitId: circuitId as any,
        countryList,
        isIncluded,
      },
      this.deps.config.easGraphqlEndpoint,
      rpcUrls
    );

    // Choose proof generation path based on TEE mode
    let proofResult: { proof: string; publicInputs: string; proofWithInputs: string };

    if (this.deps.teeProvider && this.deps.config.teeMode === 'nitro') {
      emitter.emitStatusUpdate(
        task.id,
        {
          state: 'running',
          message: {
            role: 'agent',
            parts: [{ kind: 'text', text: 'Running proof in TEE enclave' }],
            timestamp: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
        false
      );

      // Convert circuit params to input strings for enclave
      const inputStrings = [JSON.stringify(circuitParams)];

      const teeResponse = await this.deps.teeProvider.prove(circuitId, inputStrings, task.id);

      if (teeResponse.type === 'error') {
        throw new Error(teeResponse.error || 'TEE proof generation failed');
      }

      if (teeResponse.type !== 'proof' || !teeResponse.proof) {
        throw new Error('Invalid TEE response: expected proof type');
      }

      proofResult = {
        proof: teeResponse.proof,
        publicInputs: teeResponse.publicInputs?.[0] || '0x',
        proofWithInputs: teeResponse.proof + (teeResponse.publicInputs?.[0] || '0x').slice(2),
      };
    } else {
      emitter.emitStatusUpdate(
        task.id,
        {
          state: 'running',
          message: {
            role: 'agent',
            parts: [{ kind: 'text', text: 'Running bb prove' }],
            timestamp: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
        false
      );

      const bbProver = new BbProver({
        bbPath: this.deps.config.bbPath,
        nargoPath: this.deps.config.nargoPath,
        circuitsDir: this.deps.config.circuitsDir,
      });

      proofResult = await bbProver.prove(circuitId, circuitParams);
    }

    const result = {
      proof: proofResult.proof,
      publicInputs: proofResult.publicInputs,
      proofWithInputs: proofResult.proofWithInputs,
      nullifier: ethers.hexlify(circuitParams.nullifierBytes),
      signalHash: ethers.hexlify(circuitParams.signalHash),
    };

    // Build artifact
    const artifact: Artifact = {
      id: randomUUID(),
      mimeType: 'application/json',
      parts: [{
        kind: 'data',
        mimeType: 'application/json',
        data: result,
      }],
    };

    await this.deps.taskStore.addArtifact(task.id, artifact);
    const updatedTask = await this.deps.taskStore.updateTaskStatus(task.id, 'completed');
    emitter.emitArtifactUpdate(task.id, artifact);
    emitter.emitStatusUpdate(
      task.id,
      { state: 'completed', timestamp: new Date().toISOString() },
      true
    );
    emitter.emitTaskComplete(task.id, updatedTask);

    // Increment reputation after successful proof (non-blocking)
    if (this.deps.config.erc8004ReputationAddress) {
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
  }

  private async processVerifyProof(task: A2aTask): Promise<void> {
    const { params } = task;
    const emitter = this.deps.taskEventEmitter;

    await this.deps.taskStore.updateTaskStatus(task.id, 'running');
    emitter.emitStatusUpdate(
      task.id,
      { state: 'running', timestamp: new Date().toISOString() },
      false
    );

    const circuitId = params.circuitId as string;
    const proof = params.proof as string;
    const rawPublicInputs = params.publicInputs as string | string[] | undefined;
    const chainId = (params.chainId as string) || '84532';

    if (!circuitId || !proof || !rawPublicInputs) {
      throw new Error('Missing required parameters: circuitId, proof, publicInputs');
    }

    // Handle both string and string[] formats for publicInputs
    let publicInputsArray: string[];

    if (typeof rawPublicInputs === 'string') {
      // Single hex string from generate_proof — split into 32-byte (64 char) chunks
      const hex = rawPublicInputs.startsWith('0x') ? rawPublicInputs.slice(2) : rawPublicInputs;
      publicInputsArray = [];
      for (let i = 0; i < hex.length; i += 64) {
        publicInputsArray.push('0x' + hex.slice(i, i + 64));
      }
    } else if (Array.isArray(rawPublicInputs)) {
      publicInputsArray = rawPublicInputs;
    } else {
      throw new Error('publicInputs must be a hex string or array of hex strings');
    }

    emitter.emitStatusUpdate(
      task.id,
      {
        state: 'running',
        message: {
          role: 'agent',
          parts: [{ kind: 'text', text: 'Calling on-chain verifier' }],
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      },
      false
    );

    const circuit = CIRCUITS[circuitId as keyof typeof CIRCUITS];
    if (!circuit) {
      throw new Error(`Unknown circuit: ${circuitId}`);
    }

    const chainVerifiers = VERIFIER_ADDRESSES[chainId];
    if (!chainVerifiers || !chainVerifiers[circuitId]) {
      throw new Error(`No verifier deployed for circuit "${circuitId}" on chain "${chainId}"`);
    }

    const verifierAddress = chainVerifiers[circuitId];

    const provider = new ethers.JsonRpcProvider(this.deps.config.chainRpcUrl);
    const verifierContract = new ethers.Contract(
      verifierAddress,
      ['function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool)'],
      provider
    );

    let isValid: boolean;
    try {
      if (publicInputsArray.length > 0) {
        const inputsAsBytes32 = publicInputsArray.map(input => input.startsWith('0x') ? input : `0x${input}`);
        isValid = await verifierContract.verify(proof, inputsAsBytes32);
      } else {
        throw new Error('No public inputs provided');
      }
    } catch (verifyError: any) {
      // Contract revert or call error — return artifact with valid: false
      const errorResult = {
        valid: false,
        circuitId,
        verifierAddress,
        chainId,
        error: verifyError.message || String(verifyError),
      };

      const artifact: Artifact = {
        id: randomUUID(),
        mimeType: 'application/json',
        parts: [{
          kind: 'data',
          mimeType: 'application/json',
          data: errorResult,
        }],
      };

      await this.deps.taskStore.addArtifact(task.id, artifact);
      const updatedTask = await this.deps.taskStore.updateTaskStatus(task.id, 'completed');
      emitter.emitArtifactUpdate(task.id, artifact);
      emitter.emitStatusUpdate(
        task.id,
        { state: 'completed', timestamp: new Date().toISOString() },
        true
      );
      emitter.emitTaskComplete(task.id, updatedTask);
      return;
    }

    const result = {
      valid: isValid,
      circuitId,
      verifierAddress,
      chainId,
    };

    // Build artifact
    const artifact: Artifact = {
      id: randomUUID(),
      mimeType: 'application/json',
      parts: [{
        kind: 'data',
        mimeType: 'application/json',
        data: result,
      }],
    };

    await this.deps.taskStore.addArtifact(task.id, artifact);
    const updatedTask = await this.deps.taskStore.updateTaskStatus(task.id, 'completed');
    emitter.emitArtifactUpdate(task.id, artifact);
    emitter.emitStatusUpdate(
      task.id,
      { state: 'completed', timestamp: new Date().toISOString() },
      true
    );
    emitter.emitTaskComplete(task.id, updatedTask);
  }

  private async processGetSupportedCircuits(task: A2aTask): Promise<void> {
    const emitter = this.deps.taskEventEmitter;

    await this.deps.taskStore.updateTaskStatus(task.id, 'running');
    emitter.emitStatusUpdate(
      task.id,
      { state: 'running', timestamp: new Date().toISOString() },
      false
    );

    const chainId = (task.params.chainId as string) || '84532';
    const chainVerifiers = VERIFIER_ADDRESSES[chainId] || {};

    const circuits = Object.entries(CIRCUITS).map(([id, circuit]) => ({
      id,
      displayName: circuit.displayName,
      description: circuit.description,
      verifierAddress: chainVerifiers[id] || null,
      easSchemaId: circuit.easSchemaId,
      functionSelector: circuit.functionSelector,
      requiredInputs: circuit.requiredInputs,
    }));

    const result = { circuits, chainId };

    // Build artifact
    const artifact: Artifact = {
      id: randomUUID(),
      mimeType: 'application/json',
      parts: [{
        kind: 'data',
        mimeType: 'application/json',
        data: result,
      }],
    };

    await this.deps.taskStore.addArtifact(task.id, artifact);
    const updatedTask = await this.deps.taskStore.updateTaskStatus(task.id, 'completed');
    emitter.emitArtifactUpdate(task.id, artifact);
    emitter.emitStatusUpdate(
      task.id,
      { state: 'completed', timestamp: new Date().toISOString() },
      true
    );
    emitter.emitTaskComplete(task.id, updatedTask);
  }
}
