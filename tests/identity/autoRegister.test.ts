import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../src/config/index.js';

// Records every config ensureAgentRegistered hands to AgentRegistration, so the
// per-chain wiring can be asserted rather than assumed. vi.hoisted() so the
// vi.mock factory below can close over it.
const { constructorConfigs } = vi.hoisted(() => ({ constructorConfigs: [] as any[] }));

// Mock the register module
vi.mock('../../src/identity/register.js', () => {
  const mockRegister = vi.fn();
  const mockIsRegistered = vi.fn();
  const mockGetRegistration = vi.fn();
  const mockUpdateMetadata = vi.fn();
  const mockGetTokenMetadata = vi.fn();
  const mockGetOnchainMetadata = vi.fn();
  const mockSetOnchainMetadata = vi.fn();

  class MockAgentRegistration {
    constructor(config: any) {
      // Mirror the real constructor's validation: a chain whose RPC URL is
      // missing must fail here, exactly as AgentRegistration does, or the test
      // would claim registration succeeds on an unconfigured chain.
      if (!config.chainRpcUrl) throw new Error('chainRpcUrl is required');
      constructorConfigs.push(config);
      this.config = config;
    }
    config: any;
    register = mockRegister;
    isRegistered = mockIsRegistered;
    getRegistration = mockGetRegistration;
    updateMetadata = mockUpdateMetadata;
    getTokenMetadata = mockGetTokenMetadata;
    getOnchainMetadata = mockGetOnchainMetadata;
    setOnchainMetadata = mockSetOnchainMetadata;
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

// ensureAgentRegistered registers on EVERY chain getChainIdentities() yields and
// returns a Map of chainId -> tokenId. A sepolia chainRpcUrl means the testnet
// pair below; every per-chain spy is therefore called once per chain.
const ETHEREUM_SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;

describe('ensureAgentRegistered', () => {
  let ensureAgentRegistered: any;
  let AgentRegistration: any;
  let mockRegister: any;
  let mockIsRegistered: any;
  let mockGetRegistration: any;
  let mockUpdateMetadata: any;
  let mockGetTokenMetadata: any;
  let mockGetOnchainMetadata: any;
  let mockSetOnchainMetadata: any;

  const validConfig: Config = {
    erc8004IdentityAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    erc8004ReputationAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    chainRpcUrl: 'https://sepolia.base.org',
    ethereumRpcUrl: 'https://sepolia.infura.example/v3/key',
    agentTokenId: '',
    agentTokenIdEthereum: '',
    teeMode: 'disabled',
    proverPrivateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
    a2aBaseUrl: 'https://ai.zkproofport.app',
    websiteUrl: 'https://zkproofport.com',
    port: 4002,
    nodeEnv: 'development',
    circuitsPath: './circuits',
    redisUrl: 'redis://localhost:6379',
    enableProofGeneration: true,
    enableProofVerification: true,
  } as unknown as Config;

  /** Metadata ensureAgentRegistered must send for one chain of the testnet pair. */
  const expectedMetadata = (chainId: number, agentName: string) => ({
    name: agentName,
    description: 'Autonomous ZK proof generation. ERC-8004 identity. x402 payments. Powered by ZKProofport',
    agentType: 'service',
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
    tags: ['ZK', 'Privacy', 'Proof', 'Coinbase', 'KYC', 'Attestation', 'x402', 'Identity', 'Country', 'Verification', 'Base', 'USDC', 'TEE', 'Noir', 'EAS', 'Zero-Knowledge'],
    x402Support: true,
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    image: 'https://ai.zkproofport.app/icon.png',
    protocolVersions: ['0.3'],
    securitySchemes: {
      x402: { type: 'apiKey', in: 'header', name: 'X-402-Payment' },
    },
    security: [{ x402: [] }],
    services: [
      { name: 'web', endpoint: 'https://ai.zkproofport.app' },
      { name: 'MCP', endpoint: 'https://ai.zkproofport.app/mcp', version: '2025-11-25', mcpTools: ['prove', 'get_supported_circuits', 'get_guide'] },
      { name: 'A2A', endpoint: 'https://ai.zkproofport.app/.well-known/agent-card.json', version: '0.3.0', a2aSkills: ['prove', 'get_supported_circuits', 'get_guide'] },
      { name: 'OASF', endpoint: 'https://ai.zkproofport.app', version: 'v0.8.0', skills: ['security_privacy/privacy_risk_assessment', 'security_privacy/threat_detection'], domains: ['technology/blockchain', 'technology/security', 'trust_and_safety/data_privacy'] },
      { name: 'ENS', endpoint: agentName },
      { name: 'DID', endpoint: 'did:web:ai.zkproofport.app' },
      { name: 'agentWallet', endpoint: `eip155:${chainId}:0x1234567890123456789012345678901234567890` },
    ],
    categories: ['privacy', 'security', 'verification', 'identity'],
    domains: [
      { name: 'technology/blockchain', id: 109 },
      { name: 'technology/security', id: 107 },
      { name: 'trust_and_safety/data_privacy', id: 404 },
    ],
    skills: [
      { name: 'security_privacy/privacy_risk_assessment', id: 804 },
      { name: 'security_privacy/threat_detection', id: 801 },
    ],
    registrations: [],
    supportedTrust: ['tee-attestation'],
    active: true,
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Dynamic import to get fresh mocked module
    const registerModule = await import('../../src/identity/register.js');
    AgentRegistration = registerModule.AgentRegistration;

    // Get mock functions (arrow function class fields are on instances, not prototype)
    const tempInstance = new AgentRegistration({ chainRpcUrl: 'https://example.invalid' });
    mockRegister = tempInstance.register;
    mockIsRegistered = tempInstance.isRegistered;
    mockGetRegistration = tempInstance.getRegistration;
    mockUpdateMetadata = tempInstance.updateMetadata;
    mockGetTokenMetadata = tempInstance.getTokenMetadata;
    mockGetOnchainMetadata = tempInstance.getOnchainMetadata;
    mockSetOnchainMetadata = tempInstance.setOnchainMetadata;

    // Defaults for the post-registration bookkeeping every chain performs.
    mockGetOnchainMetadata.mockResolvedValue('true');
    mockSetOnchainMetadata.mockResolvedValue('0xactivetx');
    mockUpdateMetadata.mockResolvedValue('0xupdatetx');
    mockGetTokenMetadata.mockResolvedValue('');

    // Drop the throwaway instance above so only the ones ensureAgentRegistered
    // builds are recorded.
    constructorConfigs.length = 0;

    const autoRegisterModule = await import('../../src/identity/autoRegister.js');
    ensureAgentRegistered = autoRegisterModule.ensureAgentRegistered;
  });

  describe('Feature disabled checks', () => {
    it('registers on no chain when erc8004IdentityAddress is empty', async () => {
      const config = {
        ...validConfig,
        erc8004IdentityAddress: '',
      };

      const result = await ensureAgentRegistered(config);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
      expect(mockIsRegistered).not.toHaveBeenCalled();
    });

    it('registers on no chain when erc8004ReputationAddress is empty', async () => {
      const config = {
        ...validConfig,
        erc8004ReputationAddress: '',
      };

      const result = await ensureAgentRegistered(config);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
      expect(mockIsRegistered).not.toHaveBeenCalled();
    });

    it('registers on no chain when both addresses are empty', async () => {
      const config = {
        ...validConfig,
        erc8004IdentityAddress: '',
        erc8004ReputationAddress: '',
      };

      const result = await ensureAgentRegistered(config);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
      expect(mockIsRegistered).not.toHaveBeenCalled();
    });

    it('skips only the chain whose RPC URL is missing', async () => {
      // ETHEREUM_RPC_URL unset is a silent single-chain degradation in staging:
      // AgentRegistration's constructor throws, that chain is logged and dropped,
      // and Base still registers.
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockResolvedValue({
        tokenId: 7n,
        transactionHash: '0xhash',
        agentAddress: '0x1234567890123456789012345678901234567890',
      });

      const result = await ensureAgentRegistered({ ...validConfig, ethereumRpcUrl: '' });

      expect(result.has(ETHEREUM_SEPOLIA)).toBe(false);
      expect(result.get(BASE_SEPOLIA)).toBe(7n);
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });
  });

  describe('Already registered', () => {
    it('returns the existing tokenId for every chain', async () => {
      mockIsRegistered.mockResolvedValue(true);
      mockGetRegistration.mockResolvedValue({
        tokenId: 42n,
        owner: '0x1234567890123456789012345678901234567890',
        metadataUri: 'data:application/json;base64,eyJ0ZXN0IjoidHJ1ZSJ9',
        isRegistered: true,
      });

      const result = await ensureAgentRegistered(validConfig);

      expect(result.size).toBe(2);
      expect(result.get(ETHEREUM_SEPOLIA)).toBe(42n);
      expect(result.get(BASE_SEPOLIA)).toBe(42n);
      expect(mockIsRegistered).toHaveBeenCalledTimes(2);
      expect(mockGetRegistration).toHaveBeenCalledTimes(2);
      expect(mockRegister).not.toHaveBeenCalled();
      // The stub metadata above ({"test":true}) is missing every field
      // needsMetadataUpdate() checks, so both chains must be refreshed.
      expect(mockUpdateMetadata).toHaveBeenCalledTimes(2);
      expect(mockUpdateMetadata.mock.calls[0][0]).toBe(42n);
    });

    it('uses the cached tokenId instead of scanning when one is configured', async () => {
      mockIsRegistered.mockResolvedValue(true);
      mockGetTokenMetadata.mockResolvedValue('data:application/json;base64,eyJ0ZXN0IjoidHJ1ZSJ9');

      const result = await ensureAgentRegistered({
        ...validConfig,
        agentTokenId: '11',
        agentTokenIdEthereum: '22',
      });

      expect(result.get(ETHEREUM_SEPOLIA)).toBe(22n);
      expect(result.get(BASE_SEPOLIA)).toBe(11n);
      // Scanning for the tokenId is the slow path and must be skipped entirely;
      // the cached id is read straight off the contract instead.
      expect(mockGetRegistration).not.toHaveBeenCalled();
      expect(mockGetTokenMetadata).toHaveBeenCalledWith(22n);
      expect(mockGetTokenMetadata).toHaveBeenCalledWith(11n);
    });

    it('sets the on-chain active flag when it is not already true', async () => {
      mockIsRegistered.mockResolvedValue(true);
      mockGetRegistration.mockResolvedValue({
        tokenId: 42n,
        owner: '0x1234567890123456789012345678901234567890',
        metadataUri: 'data:application/json;base64,eyJ0ZXN0IjoidHJ1ZSJ9',
        isRegistered: true,
      });
      mockGetOnchainMetadata.mockResolvedValue('false');

      await ensureAgentRegistered(validConfig);

      expect(mockSetOnchainMetadata).toHaveBeenCalledTimes(2);
      expect(mockSetOnchainMetadata).toHaveBeenCalledWith(42n, 'active', 'true');
    });
  });

  describe('New registration', () => {
    it('registers a new agent on every chain and returns each tokenId', async () => {
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockResolvedValue({
        tokenId: 1n,
        transactionHash: '0xtxhash123',
        agentAddress: '0x1234567890123456789012345678901234567890',
      });

      const result = await ensureAgentRegistered(validConfig);

      expect(result.size).toBe(2);
      expect(result.get(ETHEREUM_SEPOLIA)).toBe(1n);
      expect(result.get(BASE_SEPOLIA)).toBe(1n);
      expect(mockIsRegistered).toHaveBeenCalledTimes(2);
      expect(mockRegister).toHaveBeenCalledTimes(2);
      expect(mockGetRegistration).not.toHaveBeenCalled();
    });

    it('passes chain-specific metadata to register() for each chain', async () => {
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockResolvedValue({
        tokenId: 5n,
        transactionHash: '0xhash',
        agentAddress: '0xaddr',
      });

      await ensureAgentRegistered(validConfig);

      expect(mockRegister).toHaveBeenCalledTimes(2);
      // Each chain gets its own agent name, ENS entry and eip155 wallet ref —
      // sending one chain's metadata to the other is the bug this pins down.
      expect(mockRegister.mock.calls[0][0]).toEqual(
        expectedMetadata(ETHEREUM_SEPOLIA, 'proveragent.sepolia'),
      );
      expect(mockRegister.mock.calls[1][0]).toEqual(
        expectedMetadata(BASE_SEPOLIA, 'proveragent.base.sepolia'),
      );
    });

    it('constructs one AgentRegistration per chain, each on its own RPC URL', async () => {
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockResolvedValue({
        tokenId: 1n,
        transactionHash: '0xhash',
        agentAddress: '0xaddr',
      });

      await ensureAgentRegistered(validConfig);

      // Both chains must be reached through their OWN endpoint. Sending the
      // Ethereum registration to the Base RPC would register twice on Base and
      // still return a two-entry Map, so the RPC URL is the assertion that matters.
      expect(constructorConfigs).toEqual([
        {
          identityContractAddress: validConfig.erc8004IdentityAddress,
          reputationContractAddress: validConfig.erc8004ReputationAddress,
          chainRpcUrl: validConfig.ethereumRpcUrl,
          privateKey: validConfig.proverPrivateKey,
        },
        {
          identityContractAddress: validConfig.erc8004IdentityAddress,
          reputationContractAddress: validConfig.erc8004ReputationAddress,
          chainRpcUrl: validConfig.chainRpcUrl,
          privateKey: validConfig.proverPrivateKey,
        },
      ]);
    });
  });

  // Registration must never take the server down: a failing chain is dropped
  // from the Map and the others still register.
  describe('Error handling', () => {
    it('returns an empty Map on registration error (does not throw)', async () => {
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockRejectedValue(new Error('Contract error'));

      const result = await ensureAgentRegistered(validConfig);

      expect(result.size).toBe(0);
      // Attempted once per chain — a failure on one must not abort the other.
      expect(mockRegister).toHaveBeenCalledTimes(2);
    });

    it('returns an empty Map on isRegistered error', async () => {
      mockIsRegistered.mockRejectedValue(new Error('RPC error'));

      const result = await ensureAgentRegistered(validConfig);

      expect(result.size).toBe(0);
      expect(mockIsRegistered).toHaveBeenCalledTimes(2);
    });

    it('returns an empty Map on getRegistration error when isRegistered is true', async () => {
      mockIsRegistered.mockResolvedValue(true);
      mockGetRegistration.mockRejectedValue(new Error('Query failed'));

      const result = await ensureAgentRegistered(validConfig);

      expect(result.size).toBe(0);
    });

    it('returns an empty Map on non-Error exception', async () => {
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockRejectedValue('string error');

      const result = await ensureAgentRegistered(validConfig);

      expect(result.size).toBe(0);
    });

    it('keeps the chains that succeed when one chain fails', async () => {
      mockIsRegistered.mockResolvedValue(false);
      mockRegister
        .mockRejectedValueOnce(new Error('Ethereum RPC down'))
        .mockResolvedValueOnce({
          tokenId: 9n,
          transactionHash: '0xhash',
          agentAddress: '0x1234567890123456789012345678901234567890',
        });

      const result = await ensureAgentRegistered(validConfig);

      expect(result.size).toBe(1);
      expect(result.has(ETHEREUM_SEPOLIA)).toBe(false);
      expect(result.get(BASE_SEPOLIA)).toBe(9n);
    });

    it('still returns the tokenId when post-registration bookkeeping fails', async () => {
      // setOnchainMetadata('active') is explicitly non-fatal — losing it must
      // not lose the registration itself.
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockResolvedValue({
        tokenId: 3n,
        transactionHash: '0xhash',
        agentAddress: '0x1234567890123456789012345678901234567890',
      });
      mockSetOnchainMetadata.mockRejectedValue(new Error('gas estimation failed'));

      const result = await ensureAgentRegistered(validConfig);

      expect(result.get(ETHEREUM_SEPOLIA)).toBe(3n);
      expect(result.get(BASE_SEPOLIA)).toBe(3n);
    });
  });
});
