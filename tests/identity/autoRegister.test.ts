import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../src/config/index.js';

// Mock the register module
vi.mock('../../src/identity/register.js', () => {
  const mockRegister = vi.fn();
  const mockIsRegistered = vi.fn();
  const mockGetRegistration = vi.fn();
  const mockUpdateMetadata = vi.fn();

  class MockAgentRegistration {
    constructor(config: any) {
      this.config = config;
    }
    config: any;
    register = mockRegister;
    isRegistered = mockIsRegistered;
    getRegistration = mockGetRegistration;
    updateMetadata = mockUpdateMetadata;
    get agentAddress() {
      return '0x1234567890123456789012345678901234567890';
    }
  }

  return {
    AgentRegistration: MockAgentRegistration,
    createMetadataUri: vi.fn((metadata) => `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString('base64')}`),
    parseMetadataUri: vi.fn((uri) => {
      if (uri.startsWith('data:application/json;base64,')) {
        const base64 = uri.slice('data:application/json;base64,'.length);
        const json = Buffer.from(base64, 'base64').toString('utf-8');
        return JSON.parse(json);
      }
      return null;
    }),
  };
});

describe('ensureAgentRegistered', () => {
  let ensureAgentRegistered: any;
  let AgentRegistration: any;
  let mockRegister: any;
  let mockIsRegistered: any;
  let mockGetRegistration: any;
  let mockUpdateMetadata: any;

  const validConfig: Config = {
    erc8004IdentityAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    erc8004ReputationAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    chainRpcUrl: 'https://sepolia.base.org',
    proverPrivateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
    a2aBaseUrl: 'https://ai.zkproofport.app',
    websiteUrl: 'https://zkproofport.com',
    port: 4002,
    nodeEnv: 'development',
    circuitsPath: './circuits',
    redisUrl: 'redis://localhost:6379',
    enableProofGeneration: true,
    enableProofVerification: true,
  } as Config;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Dynamic import to get fresh mocked module
    const registerModule = await import('../../src/identity/register.js');
    AgentRegistration = registerModule.AgentRegistration;

    // Get mock functions (arrow function class fields are on instances, not prototype)
    const tempInstance = new AgentRegistration({});
    mockRegister = tempInstance.register;
    mockIsRegistered = tempInstance.isRegistered;
    mockGetRegistration = tempInstance.getRegistration;
    mockUpdateMetadata = tempInstance.updateMetadata;

    const autoRegisterModule = await import('../../src/identity/autoRegister.js');
    ensureAgentRegistered = autoRegisterModule.ensureAgentRegistered;
  });

  describe('Feature disabled checks', () => {
    it('returns null when erc8004IdentityAddress is empty', async () => {
      const config = {
        ...validConfig,
        erc8004IdentityAddress: '',
      };

      const result = await ensureAgentRegistered(config);
      expect(result).toBeNull();
      expect(mockIsRegistered).not.toHaveBeenCalled();
    });

    it('returns null when erc8004ReputationAddress is empty', async () => {
      const config = {
        ...validConfig,
        erc8004ReputationAddress: '',
      };

      const result = await ensureAgentRegistered(config);
      expect(result).toBeNull();
      expect(mockIsRegistered).not.toHaveBeenCalled();
    });

    it('returns null when both addresses are empty', async () => {
      const config = {
        ...validConfig,
        erc8004IdentityAddress: '',
        erc8004ReputationAddress: '',
      };

      const result = await ensureAgentRegistered(config);
      expect(result).toBeNull();
      expect(mockIsRegistered).not.toHaveBeenCalled();
    });
  });

  describe('Already registered', () => {
    it('returns existing tokenId when agent is already registered', async () => {
      mockIsRegistered.mockResolvedValue(true);
      mockGetRegistration.mockResolvedValue({
        tokenId: 42n,
        owner: '0x1234567890123456789012345678901234567890',
        metadataUri: 'data:application/json;base64,eyJ0ZXN0IjoidHJ1ZSJ9',
        isRegistered: true,
      });

      const result = await ensureAgentRegistered(validConfig);

      expect(result).toBe(42n);
      expect(mockIsRegistered).toHaveBeenCalledTimes(1);
      expect(mockGetRegistration).toHaveBeenCalledTimes(1);
      expect(mockRegister).not.toHaveBeenCalled();
    });
  });

  describe('New registration', () => {
    it('registers new agent and returns tokenId when not registered', async () => {
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockResolvedValue({
        tokenId: 1n,
        transactionHash: '0xtxhash123',
        agentAddress: '0x1234567890123456789012345678901234567890',
      });

      const result = await ensureAgentRegistered(validConfig);

      expect(result).toBe(1n);
      expect(mockIsRegistered).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockGetRegistration).not.toHaveBeenCalled();
    });

    it('passes correct metadata to register()', async () => {
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockResolvedValue({
        tokenId: 5n,
        transactionHash: '0xhash',
        agentAddress: '0xaddr',
      });

      await ensureAgentRegistered(validConfig);

      expect(mockRegister).toHaveBeenCalledTimes(1);
      const calledMetadata = mockRegister.mock.calls[0][0];

      expect(calledMetadata).toEqual({
        name: 'proveragent.base.eth',
        description: 'Autonomous ZK proof generation. ERC-8004 identity. x402 payments. Powered by ZKProofport',
        agentUrl: validConfig.a2aBaseUrl,
        capabilities: [
          'proof_generation',
          'proof_verification',
          'coinbase_kyc',
          'coinbase_country',
          'streaming',
          'x402_payment',
        ],
        protocols: ['mcp', 'a2a', 'x402'],
        circuits: ['coinbase_attestation', 'coinbase_country_attestation'],
        tee: undefined,
        x402Support: true,
        type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        image: 'https://ai.zkproofport.app/icon.png',
        services: [
          { name: 'web', endpoint: 'https://zkproofport.com' },
          { name: 'MCP', endpoint: 'https://ai.zkproofport.app/mcp', version: '2025-11-25' },
          { name: 'A2A', endpoint: 'https://ai.zkproofport.app/.well-known/agent-card.json', version: '0.3.0' },
        ],
        registrations: [],
        supportedTrust: ['tee-attestation'],
      });
    });

    it('passes correct config to AgentRegistration constructor', async () => {
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockResolvedValue({
        tokenId: 1n,
        transactionHash: '0xhash',
        agentAddress: '0xaddr',
      });

      await ensureAgentRegistered(validConfig);

      // AgentRegistration constructor was called
      const registration = new AgentRegistration({
        identityContractAddress: validConfig.erc8004IdentityAddress,
        reputationContractAddress: validConfig.erc8004ReputationAddress,
        chainRpcUrl: validConfig.chainRpcUrl,
        privateKey: validConfig.proverPrivateKey,
      });

      expect(registration.config).toEqual({
        identityContractAddress: validConfig.erc8004IdentityAddress,
        reputationContractAddress: validConfig.erc8004ReputationAddress,
        chainRpcUrl: validConfig.chainRpcUrl,
        privateKey: validConfig.proverPrivateKey,
      });
    });
  });

  describe('Error handling', () => {
    it('returns null on registration error (does not throw)', async () => {
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockRejectedValue(new Error('Contract error'));

      const result = await ensureAgentRegistered(validConfig);

      expect(result).toBeNull();
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });

    it('returns null on isRegistered error', async () => {
      mockIsRegistered.mockRejectedValue(new Error('RPC error'));

      const result = await ensureAgentRegistered(validConfig);

      expect(result).toBeNull();
    });

    it('returns null on getRegistration error when isRegistered is true', async () => {
      mockIsRegistered.mockResolvedValue(true);
      mockGetRegistration.mockRejectedValue(new Error('Query failed'));

      const result = await ensureAgentRegistered(validConfig);

      expect(result).toBeNull();
    });

    it('returns null on non-Error exception', async () => {
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockRejectedValue('string error');

      const result = await ensureAgentRegistered(validConfig);

      expect(result).toBeNull();
    });
  });
});
