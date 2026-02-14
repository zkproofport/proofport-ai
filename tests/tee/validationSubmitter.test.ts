import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';

const mockGetIdentityRegistry = vi.fn();
const mockGetAgentValidations = vi.fn();
const mockGetValidationStatus = vi.fn();
const mockValidationRequest = vi.fn();
const mockValidationResponse = vi.fn();
const mockWait = vi.fn().mockResolvedValue({});

const mockRegister = vi.fn();
const mockIsRegistered = vi.fn();
const mockGetRegistration = vi.fn();

vi.mock('../../src/identity/register.js', () => {
  class MockAgentRegistration {
    constructor(config: any) {
      this.config = config;
    }
    config: any;
    register = mockRegister;
    isRegistered = mockIsRegistered;
    getRegistration = mockGetRegistration;
    get agentAddress() {
      return '0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c';
    }
  }
  return {
    AgentRegistration: MockAgentRegistration,
    createMetadataUri: vi.fn(),
  };
});

vi.mock('ethers', () => {
  return {
    ethers: {
      JsonRpcProvider: vi.fn(),
      Wallet: vi.fn().mockImplementation(() => ({
        address: '0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c',
      })),
      Contract: vi.fn().mockImplementation(() => ({
        getIdentityRegistry: mockGetIdentityRegistry,
        getAgentValidations: mockGetAgentValidations,
        getValidationStatus: mockGetValidationStatus,
        validationRequest: mockValidationRequest,
        validationResponse: mockValidationResponse,
      })),
      keccak256: vi.fn().mockReturnValue('0xmockhash'),
      toUtf8Bytes: vi.fn().mockReturnValue(new Uint8Array()),
      encodeBytes32String: vi.fn().mockImplementation((s: string) => `0x${Buffer.from(s).toString('hex').padEnd(64, '0')}`),
    },
  };
});

describe('ensureAgentValidated', () => {
  let ensureAgentValidated: any;

  const validConfig = {
    erc8004IdentityAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    erc8004ReputationAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    erc8004ValidationAddress: '0x8004C269D0A5647E51E121FeB226200ECE932d55',
    chainRpcUrl: 'https://sepolia.base.org',
    proverPrivateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
    teeMode: 'local' as const,
  } as any;

  const mockTeeProvider = {
    mode: 'local' as const,
    prove: vi.fn(),
    healthCheck: vi.fn(),
    getAttestation: vi.fn(),
    generateAttestation: vi.fn().mockResolvedValue({
      document: 'base64doc',
      mode: 'local',
      proofHash: '0xhash',
      timestamp: Date.now(),
    }),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const module = await import('../../src/tee/validationSubmitter.js');
    ensureAgentValidated = module.ensureAgentValidated;

    mockValidationRequest.mockResolvedValue({ wait: mockWait, hash: '0xtxhash' });
    mockValidationResponse.mockResolvedValue({ wait: mockWait, hash: '0xtxhash' });
    mockRegister.mockResolvedValue({ tokenId: 100n, transactionHash: '0xreghash', agentAddress: '0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c' });
    mockIsRegistered.mockResolvedValue(false);
    mockGetRegistration.mockResolvedValue(null);
  });

  describe('Skip conditions', () => {
    it('returns early when erc8004ValidationAddress is empty', async () => {
      const config = {
        ...validConfig,
        erc8004ValidationAddress: '',
      };

      await ensureAgentValidated(config, 1n, mockTeeProvider);

      expect(mockGetIdentityRegistry).not.toHaveBeenCalled();
    });

    it('returns early when teeMode is disabled', async () => {
      const config = {
        ...validConfig,
        teeMode: 'disabled' as const,
      };

      await ensureAgentValidated(config, 1n, mockTeeProvider);

      expect(mockGetIdentityRegistry).not.toHaveBeenCalled();
    });
  });

  describe('Cross-Identity registration', () => {
    it('registers on ValidationRegistry Identity when contracts differ', async () => {
      mockGetIdentityRegistry.mockResolvedValue('0xDifferentIdentityAddress');
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockResolvedValue({ tokenId: 100n, transactionHash: '0xreghash', agentAddress: '0xaddr' });
      mockGetAgentValidations.mockResolvedValue([]);

      await ensureAgentValidated(validConfig, 1n, mockTeeProvider);

      expect(mockIsRegistered).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockGetAgentValidations).toHaveBeenCalledWith(100n);
      expect(mockValidationRequest).toHaveBeenCalled();
    });

    it('uses existing registration on ValidationRegistry Identity', async () => {
      mockGetIdentityRegistry.mockResolvedValue('0xDifferentIdentityAddress');
      mockIsRegistered.mockResolvedValue(true);
      mockGetRegistration.mockResolvedValue({ tokenId: 50n, owner: '0xaddr', metadataUri: '', isRegistered: true });
      mockGetAgentValidations.mockResolvedValue([]);

      await ensureAgentValidated(validConfig, 1n, mockTeeProvider);

      expect(mockIsRegistered).toHaveBeenCalledTimes(1);
      expect(mockRegister).not.toHaveBeenCalled();
      expect(mockGetAgentValidations).toHaveBeenCalledWith(50n);
      expect(mockValidationRequest).toHaveBeenCalled();
    });

    it('continues with original tokenId when registries match (case-insensitive)', async () => {
      mockGetIdentityRegistry.mockResolvedValue(validConfig.erc8004IdentityAddress.toLowerCase());
      mockGetAgentValidations.mockResolvedValue([]);

      await ensureAgentValidated(validConfig, 42n, mockTeeProvider);

      expect(mockIsRegistered).not.toHaveBeenCalled();
      expect(mockGetAgentValidations).toHaveBeenCalledWith(42n);
      expect(mockValidationRequest).toHaveBeenCalled();
    });
  });

  describe('Already validated', () => {
    it('returns early when TEE tag validation exists', async () => {
      mockGetIdentityRegistry.mockResolvedValue(validConfig.erc8004IdentityAddress);
      mockGetAgentValidations.mockResolvedValue(['0xhash1']);
      mockGetValidationStatus.mockResolvedValue([
        '0xvalidator',
        1n,
        100,
        '0xresponsehash',
        ethers.encodeBytes32String('tee-attestation'),
        Date.now(),
      ]);

      await ensureAgentValidated(validConfig, 1n, mockTeeProvider);

      expect(mockGetAgentValidations).toHaveBeenCalledWith(1n);
      expect(mockGetValidationStatus).toHaveBeenCalledWith('0xhash1');
      expect(mockValidationRequest).not.toHaveBeenCalled();
    });

    it('continues when validation exists but has different tag', async () => {
      mockGetIdentityRegistry.mockResolvedValue(validConfig.erc8004IdentityAddress);
      mockGetAgentValidations.mockResolvedValue(['0xhash1']);
      mockGetValidationStatus.mockResolvedValue([
        '0xvalidator',
        1n,
        100,
        '0xresponsehash',
        ethers.encodeBytes32String('different-tag'),
        Date.now(),
      ]);

      await ensureAgentValidated(validConfig, 1n, mockTeeProvider);

      expect(mockValidationRequest).toHaveBeenCalled();
    });

    it('continues when validation exists but response is 0', async () => {
      mockGetIdentityRegistry.mockResolvedValue(validConfig.erc8004IdentityAddress);
      mockGetAgentValidations.mockResolvedValue(['0xhash1']);
      mockGetValidationStatus.mockResolvedValue([
        '0xvalidator',
        1n,
        0,
        '0xresponsehash',
        ethers.encodeBytes32String('tee-attestation'),
        Date.now(),
      ]);

      await ensureAgentValidated(validConfig, 1n, mockTeeProvider);

      expect(mockValidationRequest).toHaveBeenCalled();
    });

    it('skips invalid validations and continues', async () => {
      mockGetIdentityRegistry.mockResolvedValue(validConfig.erc8004IdentityAddress);
      mockGetAgentValidations.mockResolvedValue(['0xhash1', '0xhash2']);
      mockGetValidationStatus
        .mockRejectedValueOnce(new Error('Invalid hash'))
        .mockResolvedValueOnce([
          '0xvalidator',
          1n,
          0,
          '0xresponsehash',
          ethers.encodeBytes32String('tee-attestation'),
          Date.now(),
        ]);

      await ensureAgentValidated(validConfig, 1n, mockTeeProvider);

      expect(mockGetValidationStatus).toHaveBeenCalledTimes(2);
      expect(mockValidationRequest).toHaveBeenCalled();
    });
  });

  describe('Successful validation flow', () => {
    it('completes full validation flow when not validated', async () => {
      mockGetIdentityRegistry.mockResolvedValue(validConfig.erc8004IdentityAddress);
      mockGetAgentValidations.mockResolvedValue([]);

      await ensureAgentValidated(validConfig, 42n, mockTeeProvider);

      expect(mockGetIdentityRegistry).toHaveBeenCalledTimes(1);
      expect(mockGetAgentValidations).toHaveBeenCalledWith(42n);
      expect(mockTeeProvider.generateAttestation).toHaveBeenCalledWith('0xmockhash');
      expect(mockValidationRequest).toHaveBeenCalledWith(
        '0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c',
        42n,
        expect.stringContaining('data:application/json;base64,'),
        '0xmockhash'
      );
      expect(mockWait).toHaveBeenCalledTimes(2);
      expect(mockValidationResponse).toHaveBeenCalledWith(
        '0xmockhash',
        100,
        expect.stringContaining('data:application/json;base64,'),
        '0xmockhash',
        expect.any(String)
      );
    });

    it('uses cross-registered tokenId in validation request', async () => {
      mockGetIdentityRegistry.mockResolvedValue('0xOtherIdentity');
      mockIsRegistered.mockResolvedValue(false);
      mockRegister.mockResolvedValue({ tokenId: 200n, transactionHash: '0xhash', agentAddress: '0xaddr' });
      mockGetAgentValidations.mockResolvedValue([]);

      await ensureAgentValidated(validConfig, 1n, mockTeeProvider);

      expect(mockValidationRequest).toHaveBeenCalledWith(
        '0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c',
        200n,
        expect.stringContaining('data:application/json;base64,'),
        '0xmockhash'
      );
    });

    it('returns early when generateAttestation returns null', async () => {
      mockGetIdentityRegistry.mockResolvedValue(validConfig.erc8004IdentityAddress);
      mockGetAgentValidations.mockResolvedValue([]);
      mockTeeProvider.generateAttestation.mockResolvedValueOnce(null);

      await ensureAgentValidated(validConfig, 1n, mockTeeProvider);

      expect(mockValidationRequest).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('returns gracefully on contract call failure', async () => {
      mockGetIdentityRegistry.mockRejectedValue(new Error('RPC error'));

      await ensureAgentValidated(validConfig, 1n, mockTeeProvider);

      expect(mockValidationRequest).not.toHaveBeenCalled();
    });

    it('returns gracefully on validation request failure', async () => {
      mockGetIdentityRegistry.mockResolvedValue(validConfig.erc8004IdentityAddress);
      mockGetAgentValidations.mockResolvedValue([]);
      mockValidationRequest.mockRejectedValue(new Error('Transaction failed'));

      await ensureAgentValidated(validConfig, 1n, mockTeeProvider);

      expect(mockValidationResponse).not.toHaveBeenCalled();
    });

    it('returns gracefully on non-Error exception', async () => {
      mockGetIdentityRegistry.mockResolvedValue(validConfig.erc8004IdentityAddress);
      mockGetAgentValidations.mockRejectedValue('string error');

      await ensureAgentValidated(validConfig, 1n, mockTeeProvider);

      expect(mockValidationRequest).not.toHaveBeenCalled();
    });
  });
});
