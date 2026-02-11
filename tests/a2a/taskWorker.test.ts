import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskWorker } from '../../src/a2a/taskWorker.js';
import { TaskStore } from '../../src/a2a/taskStore.js';
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
    vi.spyOn(mockTaskStore, 'updateTaskStatus').mockImplementation(async (id, status, result, error) => ({
      id,
      status,
      skill: 'generate_proof',
      params: {},
      result,
      error,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    // Mock TaskEventEmitter methods
    vi.spyOn(mockTaskEventEmitter, 'emitTaskStatus');
    vi.spyOn(mockTaskEventEmitter, 'emitTaskProgress');
    vi.spyOn(mockTaskEventEmitter, 'emitTaskArtifact');
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

    // Timer should be cleared (worker should only have stopped its own interval)
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

  it('5. processTask with generate_proof skill - transitions submitted→working→completed, emits events', async () => {
    const task = {
      id: 'task-generate-123',
      status: 'submitted' as const,
      skill: 'generate_proof',
      params: {
        address: '0xUser1111111111111111111111111111111111111',
        signature: '0xsig123',
        scope: 'test-scope',
        circuitId: 'coinbase_attestation',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await worker.processTask(task);

    // Verify status transitions
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('task-generate-123', 'working');
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith(
      'task-generate-123',
      'completed',
      expect.objectContaining({
        proof: '0xproof123',
        publicInputs: '0xpublic456',
        proofWithInputs: '0xproof123public456',
        nullifier: expect.any(String),
        signalHash: expect.any(String),
      })
    );

    // Verify events
    expect(mockTaskEventEmitter.emitTaskStatus).toHaveBeenCalledWith('task-generate-123', 'working');
    expect(mockTaskEventEmitter.emitTaskProgress).toHaveBeenCalledWith(
      'task-generate-123',
      'building_inputs',
      'Constructing circuit parameters'
    );
    expect(mockTaskEventEmitter.emitTaskProgress).toHaveBeenCalledWith(
      'task-generate-123',
      'generating_proof',
      'Running bb prove'
    );
    expect(mockTaskEventEmitter.emitTaskStatus).toHaveBeenCalledWith('task-generate-123', 'completed');
    expect(mockTaskEventEmitter.emitTaskArtifact).toHaveBeenCalledWith(
      'task-generate-123',
      expect.objectContaining({
        proof: '0xproof123',
      })
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

  it('6. processTask with verify_proof skill - calls on-chain verifier', async () => {
    const task = {
      id: 'task-verify-456',
      status: 'submitted' as const,
      skill: 'verify_proof',
      params: {
        circuitId: 'coinbase_attestation',
        proofWithInputs: '0xproof123public456',
        chainId: '84532',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await worker.processTask(task);

    // Verify status transitions
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('task-verify-456', 'working');
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith(
      'task-verify-456',
      'completed',
      expect.objectContaining({
        valid: true,
        circuitId: 'coinbase_attestation',
        verifierAddress: '0xVerifier1111111111111111111111111111111111',
        chainId: '84532',
      })
    );

    // Verify events
    expect(mockTaskEventEmitter.emitTaskStatus).toHaveBeenCalledWith('task-verify-456', 'working');
    expect(mockTaskEventEmitter.emitTaskProgress).toHaveBeenCalledWith(
      'task-verify-456',
      'verifying',
      'Calling on-chain verifier'
    );
    expect(mockTaskEventEmitter.emitTaskStatus).toHaveBeenCalledWith('task-verify-456', 'completed');

    // Verify ethers Contract was created
    expect(ethers.JsonRpcProvider).toHaveBeenCalledWith(mockConfig.chainRpcUrl);
    expect(ethers.Contract).toHaveBeenCalledWith(
      '0xVerifier1111111111111111111111111111111111',
      ['function verify(bytes calldata) external view returns (bool)'],
      expect.any(Object)
    );
  });

  it('7. processTask with get_supported_circuits - returns circuit list', async () => {
    const task = {
      id: 'task-circuits-789',
      status: 'submitted' as const,
      skill: 'get_supported_circuits',
      params: {
        chainId: '84532',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await worker.processTask(task);

    // Verify status transitions
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith('task-circuits-789', 'working');
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith(
      'task-circuits-789',
      'completed',
      expect.objectContaining({
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
      })
    );

    // Verify events
    expect(mockTaskEventEmitter.emitTaskStatus).toHaveBeenCalledWith('task-circuits-789', 'working');
    expect(mockTaskEventEmitter.emitTaskStatus).toHaveBeenCalledWith('task-circuits-789', 'completed');
  });

  it('8. processTask with unknown skill - transitions to failed', async () => {
    const task = {
      id: 'task-unknown-999',
      status: 'submitted' as const,
      skill: 'unknown_skill',
      params: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await worker.processTask(task);

    // Verify failure
    expect(mockTaskStore.updateTaskStatus).toHaveBeenCalledWith(
      'task-unknown-999',
      'failed',
      undefined,
      'Unknown skill: unknown_skill'
    );
    expect(mockTaskEventEmitter.emitTaskStatus).toHaveBeenCalledWith('task-unknown-999', 'failed');
  });

  it('9. processTask calls handleProofCompleted after successful generate_proof', async () => {
    const task = {
      id: 'task-reputation-111',
      status: 'submitted' as const,
      skill: 'generate_proof',
      params: {
        address: '0xUser1111111111111111111111111111111111111',
        signature: '0xsig123',
        scope: 'test-scope',
        circuitId: 'coinbase_attestation',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await worker.processTask(task);

    // Verify handleProofCompleted was called (non-blocking)
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

  it('11. pollAndProcess skips when already processing', async () => {
    const task = {
      id: 'task-concurrent-222',
      status: 'submitted' as const,
      skill: 'generate_proof',
      params: {
        address: '0xUser1111111111111111111111111111111111111',
        signature: '0xsig123',
        scope: 'test-scope',
        circuitId: 'coinbase_attestation',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // First rpop returns a task
    vi.mocked(mockRedis.rpop)
      .mockResolvedValueOnce('task-concurrent-222')
      .mockResolvedValueOnce('task-concurrent-333');
    vi.mocked(mockTaskStore.getTask).mockResolvedValue(task);

    // Make the first process take a long time
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

    // First poll cycle starts
    await vi.advanceTimersByTimeAsync(2000);

    // Second poll cycle - should skip because first is still processing
    await vi.advanceTimersByTimeAsync(2000);

    // Only one rpop should have happened
    expect(mockRedis.rpop).toHaveBeenCalledTimes(1);

    // Resolve the first process
    resolveFirstProcess!();
    await vi.advanceTimersByTimeAsync(100);

    worker.stop();
  });
});
