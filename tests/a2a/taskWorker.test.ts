import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskWorker } from '../../src/a2a/taskWorker.js';
import { TaskStore, type A2aTask, type Artifact } from '../../src/a2a/taskStore.js';
import { TaskEventEmitter } from '../../src/a2a/streaming.js';
import type { Config } from '../../src/config/index.js';

// Mock ioredis
vi.mock('ioredis', () => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    rpop: vi.fn(),
    quit: vi.fn(),
    status: 'ready',
  };
  return { default: vi.fn(() => mockRedis), Redis: vi.fn(() => mockRedis) };
});

// Mock BbProver
vi.mock('../../src/prover/bbProver.js', () => ({
  BbProver: vi.fn().mockImplementation(() => ({
    prove: vi.fn().mockResolvedValue({
      proof: '0xproof123',
      publicInputs: '0xpublic456',
      proofWithInputs: '0xproof123public456',
    }),
  })),
}));

// Mock computeCircuitParams
vi.mock('../../src/input/inputBuilder.js', () => ({
  computeCircuitParams: vi.fn().mockResolvedValue({
    signalHash: new Uint8Array(32).fill(1),
    merkleRoot: '0x' + '22'.repeat(32),
    scopeBytes: new Uint8Array(32).fill(3),
    nullifierBytes: new Uint8Array(32).fill(4),
    userAddress: '0x' + '55'.repeat(20),
    userSignature: '0x' + '66'.repeat(65),
    userPubkeyX: '0x' + '77'.repeat(32),
    userPubkeyY: '0x' + '88'.repeat(32),
    rawTxBytes: Array(200).fill(9),
    txLength: 200,
    attesterPubkeyX: '0x' + 'aa'.repeat(32),
    attesterPubkeyY: '0x' + 'bb'.repeat(32),
    merkleProof: ['0x' + 'cc'.repeat(32)],
    merkleLeafIndex: 0,
    merkleDepth: 1,
  }),
}));

// Mock ethers
vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
      getNetwork: vi.fn().mockResolvedValue({ chainId: 84532n }),
    })),
    Wallet: vi.fn().mockImplementation((privateKey, provider) => ({
      address: '0x1234567890123456789012345678901234567890',
      provider,
    })),
    Contract: vi.fn().mockImplementation(() => ({
      verify: vi.fn().mockResolvedValue(true),
    })),
    hexlify: vi.fn((bytes) => '0x' + Buffer.from(bytes).toString('hex')),
    encodeBytes32String: vi.fn((str) => '0x' + Buffer.from(str).toString('hex').padEnd(64, '0')),
  },
}));

// Mock handleProofCompleted
vi.mock('../../src/identity/reputation.js', () => ({
  handleProofCompleted: vi.fn().mockResolvedValue(undefined),
}));

// Mock CIRCUITS
vi.mock('../../src/config/circuits.js', () => ({
  CIRCUITS: {
    coinbase_attestation: {
      displayName: 'Coinbase KYC',
      description: 'Verify Coinbase KYC attestation',
      easSchemaId: '0x' + '11'.repeat(32),
      functionSelector: '0x12345678',
      requiredInputs: ['address', 'signature', 'scope'],
    },
    coinbase_country_attestation: {
      displayName: 'Coinbase Country',
      description: 'Verify Coinbase country attestation',
      easSchemaId: '0x' + '22'.repeat(32),
      functionSelector: '0x87654321',
      requiredInputs: ['address', 'signature', 'scope', 'countryList', 'isIncluded'],
    },
  },
}));

// Mock VERIFIER_ADDRESSES
vi.mock('../../src/config/contracts.js', () => ({
  VERIFIER_ADDRESSES: {
    '84532': {
      coinbase_attestation: '0xVerifier1111111111111111111111111111111111',
      coinbase_country_attestation: '0xVerifier2222222222222222222222222222222222',
    },
  },
}));

import { BbProver } from '../../src/prover/bbProver.js';
import { computeCircuitParams } from '../../src/input/inputBuilder.js';
import { ethers } from 'ethers';
import { handleProofCompleted } from '../../src/identity/reputation.js';
import { CIRCUITS } from '../../src/config/circuits.js';
import { VERIFIER_ADDRESSES } from '../../src/config/contracts.js';
import { createRedisClient } from '../../src/redis/client.js';

function makeA2aTask(overrides: Partial<A2aTask> = {}): A2aTask {
  return {
    id: 'task-default',
    contextId: 'ctx-1',
    status: { state: 'queued', timestamp: new Date().toISOString() },
    skill: 'generate_proof',
    params: {},
    history: [],
    artifacts: [],
    metadata: {},
    kind: 'task',
    ...overrides,
  };
}

describe('TaskWorker', () => {
  let worker: TaskWorker;
  let mockTaskStore: TaskStore;
  let mockTaskEventEmitter: TaskEventEmitter;
  let mockConfig: Config;
  let mockRedis: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockRedis = createRedisClient('redis://localhost:6379');
    mockTaskStore = new TaskStore(mockRedis, 86400);
    mockTaskEventEmitter = new TaskEventEmitter();

    mockConfig = {
      port: 4002,
      nodeEnv: 'test',
      proverUrl: '',
      bbPath: '/usr/local/bin/bb',
      nargoPath: '/usr/local/bin/nargo',
      circuitsDir: '/circuits',
      circuitsRepoUrl: 'https://example.com/circuits',
      redisUrl: 'redis://localhost:6379',
      baseRpcUrl: 'https://base-rpc.example.com',
      easGraphqlEndpoint: 'https://eas-graphql.example.com',
      chainRpcUrl: 'https://chain-rpc.example.com',
      nullifierRegistryAddress: '0xRegistry1111111111111111111111111111111111',
      proverPrivateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      paymentMode: 'disabled' as const,
      a2aBaseUrl: 'https://a2a.example.com',
      websiteUrl: 'https://zkproofport.com',
      agentVersion: '1.0.0',
      paymentPayTo: '',
      paymentFacilitatorUrl: '',
      paymentProofPrice: '$0.10',
      privyAppId: '',
      privyApiSecret: '',
      privyApiUrl: '',
      signPageUrl: '',
      signingTtlSeconds: 300,
      teeMode: 'disabled' as const,
      enclaveCid: undefined,
      enclavePort: 5000,
      teeAttestationEnabled: false,
      erc8004IdentityAddress: '',
      erc8004ReputationAddress: '0xReputation1111111111111111111111111111111',
      erc8004ValidationAddress: '',
      settlementChainRpcUrl: '',
      settlementPrivateKey: '',
      settlementOperatorAddress: '',
      settlementUsdcAddress: '',
    };

    worker = new TaskWorker({
      taskStore: mockTaskStore,
      taskEventEmitter: mockTaskEventEmitter,
      config: mockConfig,
    });

    // Mock TaskStore methods
    vi.spyOn(mockTaskStore, 'getTask').mockResolvedValue(null);
    vi.spyOn(mockTaskStore, 'updateTaskStatus').mockImplementation(async (id, state, statusMessage?) => {
      return makeA2aTask({
        id,
        status: { state, message: statusMessage, timestamp: new Date().toISOString() },
      });
    });
    vi.spyOn(mockTaskStore, 'addArtifact').mockImplementation(async (id, artifact) => {
      return makeA2aTask({ id, artifacts: [artifact] });
    });

    // Mock TaskEventEmitter methods
    vi.spyOn(mockTaskEventEmitter, 'emitStatusUpdate');
    vi.spyOn(mockTaskEventEmitter, 'emitArtifactUpdate');
    vi.spyOn(mockTaskEventEmitter, 'emitTaskComplete');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('1. constructor creates a TaskWorker instance', () => {
    expect(worker).toBeInstanceOf(TaskWorker);
  });

  it('2. start() begins polling interval', () => {
    worker.start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    worker.stop();
  });

  it('3. stop() clears polling interval', () => {
    worker.start();
    const timerCount = vi.getTimerCount();
    expect(timerCount).toBeGreaterThan(0);
    worker.stop();
    expect(vi.getTimerCount()).toBeLessThan(timerCount);
  });

  it('4. start() when already running does nothing', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    worker.start();
    const timerCount = vi.getTimerCount();
    worker.start();
    expect(vi.getTimerCount()).toBe(timerCount);
    expect(consoleLogSpy).toHaveBeenCalledWith('TaskWorker already running');
    worker.stop();
    consoleLogSpy.mockRestore();
  });

  it('5. processTask with generate_proof - transitions queued->running->completed, emits events', async () => {
    const task = makeA2aTask({
      id: 'task-generate-123',
      skill: 'generate_proof',
      params: {
        address: '0xUser1111111111111111111111111111111111111',
        signature: '0xsig123',
        scope: 'test-scope',
        circuitId: 'coinbase_attestation',
      },
    });

    await worker.processTask(task);

    // Verify status transitions
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('task-generate-123', 'running');
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('task-generate-123', 'completed');

    // Verify addArtifact was called with proper Artifact
    expect(mockTaskStore.addArtifact).toHaveBeenCalledWith(
      'task-generate-123',
      expect.objectContaining({
        id: expect.any(String),
        mimeType: 'application/json',
        parts: [expect.objectContaining({
          kind: 'data',
          mimeType: 'application/json',
          data: expect.objectContaining({
            proof: '0xproof123',
            publicInputs: '0xpublic456',
            proofWithInputs: '0xproof123public456',
            nullifier: expect.any(String),
            signalHash: expect.any(String),
          }),
        })],
      })
    );

    // Verify emitter events
    expect(mockTaskEventEmitter.emitStatusUpdate).toHaveBeenCalledWith(
      'task-generate-123',
      expect.objectContaining({ state: 'running' }),
      false
    );
    expect(mockTaskEventEmitter.emitStatusUpdate).toHaveBeenCalledWith(
      'task-generate-123',
      expect.objectContaining({ state: 'completed' }),
      true
    );
    expect(mockTaskEventEmitter.emitArtifactUpdate).toHaveBeenCalledWith(
      'task-generate-123',
      expect.objectContaining({
        id: expect.any(String),
        mimeType: 'application/json',
      })
    );
    expect(mockTaskEventEmitter.emitTaskComplete).toHaveBeenCalledWith(
      'task-generate-123',
      expect.objectContaining({ id: 'task-generate-123' })
    );

    // Verify BbProver was called
    expect(BbProver).toHaveBeenCalledWith({
      bbPath: mockConfig.bbPath,
      nargoPath: mockConfig.nargoPath,
      circuitsDir: mockConfig.circuitsDir,
    });

    // Verify computeCircuitParams was called
    expect(computeCircuitParams).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '0xUser1111111111111111111111111111111111111',
        signature: '0xsig123',
        scope: 'test-scope',
        circuitId: 'coinbase_attestation',
      }),
      mockConfig.easGraphqlEndpoint,
      [mockConfig.baseRpcUrl]
    );
  });

  it('6. processTask with verify_proof - calls on-chain verifier', async () => {
    const task = makeA2aTask({
      id: 'task-verify-456',
      skill: 'verify_proof',
      params: {
        proof: '0xdeadbeef',
        publicInputs: ['0x0000000000000000000000000000000000000000000000000000000000000001'],
        circuitId: 'coinbase_attestation',
        chainId: '84532',
      },
    });

    await worker.processTask(task);

    // Verify status transitions
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('task-verify-456', 'running');
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('task-verify-456', 'completed');

    // Verify addArtifact was called with verification result
    expect(mockTaskStore.addArtifact).toHaveBeenCalledWith(
      'task-verify-456',
      expect.objectContaining({
        mimeType: 'application/json',
        parts: [expect.objectContaining({
          kind: 'data',
          data: expect.objectContaining({
            valid: true,
            circuitId: 'coinbase_attestation',
            verifierAddress: '0xVerifier1111111111111111111111111111111111',
            chainId: '84532',
          }),
        })],
      })
    );

    // Verify emitter events
    expect(mockTaskEventEmitter.emitStatusUpdate).toHaveBeenCalledWith(
      'task-verify-456',
      expect.objectContaining({ state: 'running' }),
      false
    );
    expect(mockTaskEventEmitter.emitStatusUpdate).toHaveBeenCalledWith(
      'task-verify-456',
      expect.objectContaining({ state: 'completed' }),
      true
    );
    expect(mockTaskEventEmitter.emitTaskComplete).toHaveBeenCalledWith(
      'task-verify-456',
      expect.objectContaining({ id: 'task-verify-456' })
    );

    // Verify ethers Contract was created
    expect(ethers.JsonRpcProvider).toHaveBeenCalledWith(mockConfig.chainRpcUrl);
    expect(ethers.Contract).toHaveBeenCalledWith(
      '0xVerifier1111111111111111111111111111111111',
      ['function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool)'],
      expect.any(Object)
    );

    // Verify Contract.verify was called with proof and publicInputs
    const mockContract = vi.mocked(ethers.Contract).mock.results[0].value;
    expect(mockContract.verify).toHaveBeenCalledWith(
      '0xdeadbeef',
      ['0x0000000000000000000000000000000000000000000000000000000000000001']
    );
  });

  it('7. processTask with get_supported_circuits - returns circuit list', async () => {
    const task = makeA2aTask({
      id: 'task-circuits-789',
      skill: 'get_supported_circuits',
      params: { chainId: '84532' },
    });

    await worker.processTask(task);

    // Verify status transitions
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('task-circuits-789', 'running');
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('task-circuits-789', 'completed');

    // Verify addArtifact was called with circuits list
    expect(mockTaskStore.addArtifact).toHaveBeenCalledWith(
      'task-circuits-789',
      expect.objectContaining({
        mimeType: 'application/json',
        parts: [expect.objectContaining({
          kind: 'data',
          data: expect.objectContaining({
            circuits: expect.arrayContaining([
              expect.objectContaining({
                id: 'coinbase_attestation',
                displayName: 'Coinbase KYC',
                verifierAddress: '0xVerifier1111111111111111111111111111111111',
              }),
              expect.objectContaining({
                id: 'coinbase_country_attestation',
                displayName: 'Coinbase Country',
                verifierAddress: '0xVerifier2222222222222222222222222222222222',
              }),
            ]),
            chainId: '84532',
          }),
        })],
      })
    );

    // Verify emitter events
    expect(mockTaskEventEmitter.emitStatusUpdate).toHaveBeenCalledWith(
      'task-circuits-789',
      expect.objectContaining({ state: 'running' }),
      false
    );
    expect(mockTaskEventEmitter.emitStatusUpdate).toHaveBeenCalledWith(
      'task-circuits-789',
      expect.objectContaining({ state: 'completed' }),
      true
    );
    expect(mockTaskEventEmitter.emitTaskComplete).toHaveBeenCalledWith(
      'task-circuits-789',
      expect.objectContaining({ id: 'task-circuits-789' })
    );
  });

  it('8. processTask with unknown skill - transitions to failed with error message', async () => {
    const task = makeA2aTask({
      id: 'task-unknown-999',
      skill: 'unknown_skill',
      params: {},
    });

    // getTask is called after updateTaskStatus to emit final task event
    vi.mocked(mockTaskStore.getTask).mockResolvedValueOnce(
      makeA2aTask({ id: 'task-unknown-999', status: { state: 'failed', timestamp: new Date().toISOString() } })
    );

    await worker.processTask(task);

    // Verify failure: updateTaskStatus called with (id, 'failed', statusMessage)
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith(
      'task-unknown-999',
      'failed',
      expect.objectContaining({
        role: 'agent',
        parts: [{ kind: 'text', text: 'Unknown skill: unknown_skill' }],
        timestamp: expect.any(String),
      })
    );

    expect(mockTaskEventEmitter.emitStatusUpdate).toHaveBeenCalledWith(
      'task-unknown-999',
      expect.objectContaining({ state: 'failed' }),
      true
    );

    expect(mockTaskEventEmitter.emitTaskComplete).toHaveBeenCalledWith(
      'task-unknown-999',
      expect.any(Object)
    );
  });

  it('9. processTask calls handleProofCompleted after successful generate_proof', async () => {
    const task = makeA2aTask({
      id: 'task-reputation-111',
      skill: 'generate_proof',
      params: {
        address: '0xUser1111111111111111111111111111111111111',
        signature: '0xsig123',
        scope: 'test-scope',
        circuitId: 'coinbase_attestation',
      },
    });

    await worker.processTask(task);

    expect(handleProofCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        reputationContractAddress: mockConfig.erc8004ReputationAddress,
        chainRpcUrl: mockConfig.chainRpcUrl,
        privateKey: mockConfig.proverPrivateKey,
      }),
      '0x1234567890123456789012345678901234567890'
    );
  });

  it('10. pollAndProcess skips when no task in queue (rpop returns null)', async () => {
    vi.mocked(mockRedis.rpop).mockResolvedValue(null);

    worker.start();
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockRedis.rpop).toHaveBeenCalledWith('a2a:queue:submitted');
    expect(mockTaskStore.getTask).not.toHaveBeenCalled();

    worker.stop();
  });

  it('11. pollAndProcess skips tasks not in queued state', async () => {
    const task = makeA2aTask({
      id: 'task-running-skip',
      status: { state: 'running', timestamp: new Date().toISOString() },
    });

    vi.mocked(mockRedis.rpop).mockResolvedValueOnce('task-running-skip');
    vi.mocked(mockTaskStore.getTask).mockResolvedValueOnce(task);

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    worker.start();
    await vi.advanceTimersByTimeAsync(2000);

    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('not in queued state'));
    expect(mockTaskStore.updateTaskStatus).not.toHaveBeenCalled();

    worker.stop();
    consoleWarnSpy.mockRestore();
  });

  it('12. pollAndProcess skips when already processing', async () => {
    const task = makeA2aTask({
      id: 'task-concurrent-222',
      skill: 'generate_proof',
      params: {
        address: '0xUser1111111111111111111111111111111111111',
        signature: '0xsig123',
        scope: 'test-scope',
        circuitId: 'coinbase_attestation',
      },
    });

    vi.mocked(mockRedis.rpop)
      .mockResolvedValueOnce('task-concurrent-222')
      .mockResolvedValueOnce('task-concurrent-333');
    vi.mocked(mockTaskStore.getTask).mockResolvedValue(task);

    let resolveFirstProcess: () => void;
    const firstProcessPromise = new Promise<void>((resolve) => {
      resolveFirstProcess = resolve;
    });
    vi.mocked(computeCircuitParams).mockImplementationOnce(async () => {
      await firstProcessPromise;
      return {
        signalHash: new Uint8Array(32).fill(1),
        merkleRoot: '0x' + '22'.repeat(32),
        scopeBytes: new Uint8Array(32).fill(3),
        nullifierBytes: new Uint8Array(32).fill(4),
        userAddress: '0x' + '55'.repeat(20),
        userSignature: '0x' + '66'.repeat(65),
        userPubkeyX: '0x' + '77'.repeat(32),
        userPubkeyY: '0x' + '88'.repeat(32),
        rawTxBytes: Array(200).fill(9),
        txLength: 200,
        attesterPubkeyX: '0x' + 'aa'.repeat(32),
        attesterPubkeyY: '0x' + 'bb'.repeat(32),
        merkleProof: ['0x' + 'cc'.repeat(32)],
        merkleLeafIndex: 0,
        merkleDepth: 1,
      };
    });

    worker.start();

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    // Only one rpop should have been called
    expect(mockRedis.rpop).toHaveBeenCalledTimes(1);

    resolveFirstProcess!();
    await vi.advanceTimersByTimeAsync(100);

    worker.stop();
  });

  it('13. processTask with generate_proof routes through TEE when teeMode is not disabled', async () => {
    const mockTeeProvider = {
      mode: 'local' as const,
      prove: vi.fn().mockResolvedValue({
        type: 'proof',
        requestId: 'task-tee-test',
        proof: '0xteeproof',
        publicInputs: ['0xinput1'],
      }),
      healthCheck: vi.fn(),
      getAttestation: vi.fn(),
    };

    const teeConfig = {
      ...mockConfig,
      teeMode: 'local' as const,
    };

    const teeWorker = new TaskWorker({
      taskStore: mockTaskStore,
      taskEventEmitter: mockTaskEventEmitter,
      config: teeConfig,
      teeProvider: mockTeeProvider,
    });

    const task = makeA2aTask({
      id: 'task-tee-test',
      skill: 'generate_proof',
      params: {
        address: '0xUser1111111111111111111111111111111111111',
        signature: '0xsig123',
        scope: 'test-scope',
        circuitId: 'coinbase_attestation',
      },
    });

    await teeWorker.processTask(task);

    // Verify teeProvider.prove was called
    expect(mockTeeProvider.prove).toHaveBeenCalledWith(
      'coinbase_attestation',
      [expect.any(String)],
      'task-tee-test'
    );

    // Verify BbProver was NOT called
    expect(BbProver).not.toHaveBeenCalled();

    // Verify task completed
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('task-tee-test', 'completed');

    // Verify addArtifact called with TEE proof result
    expect(mockTaskStore.addArtifact).toHaveBeenCalledWith(
      'task-tee-test',
      expect.objectContaining({
        mimeType: 'application/json',
        parts: [expect.objectContaining({
          kind: 'data',
          data: expect.objectContaining({
            proof: '0xteeproof',
            publicInputs: '0xinput1',
          }),
        })],
      })
    );

    // Verify correct progress message about TEE
    expect(mockTaskEventEmitter.emitStatusUpdate).toHaveBeenCalledWith(
      'task-tee-test',
      expect.objectContaining({
        state: 'running',
        message: expect.objectContaining({
          role: 'agent',
          parts: [{ kind: 'text', text: 'Running proof in TEE enclave' }],
        }),
      }),
      false
    );
  });

  it('14. processTask with generate_proof uses BbProver when teeMode is disabled', async () => {
    const disabledConfig = {
      ...mockConfig,
      teeMode: 'disabled' as const,
    };

    const disabledWorker = new TaskWorker({
      taskStore: mockTaskStore,
      taskEventEmitter: mockTaskEventEmitter,
      config: disabledConfig,
    });

    const task = makeA2aTask({
      id: 'task-disabled-test',
      skill: 'generate_proof',
      params: {
        address: '0xUser1111111111111111111111111111111111111',
        signature: '0xsig123',
        scope: 'test-scope',
        circuitId: 'coinbase_attestation',
      },
    });

    await disabledWorker.processTask(task);

    // Verify BbProver WAS called
    expect(BbProver).toHaveBeenCalledWith({
      bbPath: mockConfig.bbPath,
      nargoPath: mockConfig.nargoPath,
      circuitsDir: mockConfig.circuitsDir,
    });

    // Verify task completed
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('task-disabled-test', 'completed');

    // Verify correct progress message about bb
    expect(mockTaskEventEmitter.emitStatusUpdate).toHaveBeenCalledWith(
      'task-disabled-test',
      expect.objectContaining({
        state: 'running',
        message: expect.objectContaining({
          role: 'agent',
          parts: [{ kind: 'text', text: 'Running bb prove' }],
        }),
      }),
      false
    );
  });

  it('15. processTask with generate_proof fails when TEE returns error', async () => {
    const mockTeeProvider = {
      mode: 'local' as const,
      prove: vi.fn().mockResolvedValue({
        type: 'error',
        requestId: 'task-tee-err',
        error: 'enclave unavailable',
      }),
      healthCheck: vi.fn(),
      getAttestation: vi.fn(),
    };

    const teeConfig = {
      ...mockConfig,
      teeMode: 'local' as const,
    };

    const teeWorker = new TaskWorker({
      taskStore: mockTaskStore,
      taskEventEmitter: mockTaskEventEmitter,
      config: teeConfig,
      teeProvider: mockTeeProvider,
    });

    const task = makeA2aTask({
      id: 'task-tee-err',
      skill: 'generate_proof',
      params: {
        address: '0xUser1111111111111111111111111111111111111',
        signature: '0xsig123',
        scope: 'test-scope',
        circuitId: 'coinbase_attestation',
      },
    });

    // getTask is called after updateTaskStatus to emit final task event
    vi.mocked(mockTaskStore.getTask).mockResolvedValueOnce(
      makeA2aTask({ id: 'task-tee-err', status: { state: 'failed', timestamp: new Date().toISOString() } })
    );

    await teeWorker.processTask(task);

    // Verify task failed with error message
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith(
      'task-tee-err',
      'failed',
      expect.objectContaining({
        role: 'agent',
        parts: [{ kind: 'text', text: 'enclave unavailable' }],
        timestamp: expect.any(String),
      })
    );

    expect(mockTaskEventEmitter.emitStatusUpdate).toHaveBeenCalledWith(
      'task-tee-err',
      expect.objectContaining({ state: 'failed' }),
      true
    );

    expect(mockTaskEventEmitter.emitTaskComplete).toHaveBeenCalledWith(
      'task-tee-err',
      expect.any(Object)
    );
  });

  it('16. processTask with generate_proof fails on missing required params', async () => {
    const task = makeA2aTask({
      id: 'task-missing-params',
      skill: 'generate_proof',
      params: {
        address: '0xabc',
        // missing signature, scope, circuitId
      },
    });

    await worker.processTask(task);

    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith(
      'task-missing-params',
      'failed',
      expect.objectContaining({
        role: 'agent',
        parts: [{ kind: 'text', text: expect.stringContaining('Missing required parameters') }],
      })
    );
  });
});
