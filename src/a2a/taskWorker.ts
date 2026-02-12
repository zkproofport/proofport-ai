import { TaskStore, type A2aTask } from './taskStore.js';
import { TaskEventEmitter } from './streaming.js';
import type { Config } from '../config/index.js';
import { BbProver } from '../prover/bbProver.js';
import { computeCircuitParams } from '../input/inputBuilder.js';
import { ethers } from 'ethers';
import { CIRCUITS } from '../config/circuits.js';
import { VERIFIER_ADDRESSES } from '../config/contracts.js';
import { handleProofCompleted } from '../identity/reputation.js';
import type { TeeProvider } from '../tee/types.js';

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

      if (task.status !== 'submitted') {
        console.warn(`Task ${taskId} is not in submitted state (${task.status})`);
        return;
      }

      await this.processTask(task);
    } finally {
      this.processing = false;
    }
  }

  async processTask(task: A2aTask): Promise<void> {
    const { skill, params } = task;

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
      await this.deps.taskStore.updateTaskStatus(
        task.id,
        'failed',
        undefined,
        error.message || String(error)
      );
      this.deps.taskEventEmitter.emitTaskStatus(task.id, 'failed');
    }
  }

  private async processGenerateProof(task: A2aTask): Promise<void> {
    const { params } = task;

    await this.deps.taskStore.updateTaskStatus(task.id, 'working');
    this.deps.taskEventEmitter.emitTaskStatus(task.id, 'working');

    const address = params.address as string;
    const signature = params.signature as string;
    const scope = params.scope as string;
    const circuitId = params.circuitId as string;
    const countryList = params.countryList as string[] | undefined;
    const isIncluded = params.isIncluded as boolean | undefined;

    if (!address || !signature || !scope || !circuitId) {
      throw new Error('Missing required parameters: address, signature, scope, circuitId');
    }

    this.deps.taskEventEmitter.emitTaskProgress(
      task.id,
      'building_inputs',
      'Constructing circuit parameters'
    );

    const rpcUrls = [this.deps.config.baseRpcUrl];
    const circuitParams = await computeCircuitParams(
      {
        address,
        signature,
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

    if (this.deps.teeProvider && this.deps.config.teeMode !== 'disabled') {
      this.deps.taskEventEmitter.emitTaskProgress(
        task.id,
        'generating_proof',
        'Running proof in TEE enclave'
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
      this.deps.taskEventEmitter.emitTaskProgress(
        task.id,
        'generating_proof',
        'Running bb prove'
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

    await this.deps.taskStore.updateTaskStatus(task.id, 'completed', result);
    this.deps.taskEventEmitter.emitTaskStatus(task.id, 'completed');
    this.deps.taskEventEmitter.emitTaskArtifact(task.id, result);

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

    await this.deps.taskStore.updateTaskStatus(task.id, 'working');
    this.deps.taskEventEmitter.emitTaskStatus(task.id, 'working');

    const circuitId = params.circuitId as string;
    const proofWithInputs = params.proofWithInputs as string;
    const chainId = (params.chainId as string) || '84532';

    if (!circuitId || !proofWithInputs) {
      throw new Error('Missing required parameters: circuitId, proofWithInputs');
    }

    this.deps.taskEventEmitter.emitTaskProgress(
      task.id,
      'verifying',
      'Calling on-chain verifier'
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
      ['function verify(bytes calldata) external view returns (bool)'],
      provider
    );

    const isValid = await verifierContract.verify(proofWithInputs);

    const result = {
      valid: isValid,
      circuitId,
      verifierAddress,
      chainId,
    };

    await this.deps.taskStore.updateTaskStatus(task.id, 'completed', result);
    this.deps.taskEventEmitter.emitTaskStatus(task.id, 'completed');
    this.deps.taskEventEmitter.emitTaskArtifact(task.id, result);
  }

  private async processGetSupportedCircuits(task: A2aTask): Promise<void> {
    await this.deps.taskStore.updateTaskStatus(task.id, 'working');
    this.deps.taskEventEmitter.emitTaskStatus(task.id, 'working');

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

    await this.deps.taskStore.updateTaskStatus(task.id, 'completed', result);
    this.deps.taskEventEmitter.emitTaskStatus(task.id, 'completed');
    this.deps.taskEventEmitter.emitTaskArtifact(task.id, result);
  }
}
