import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentMetadata, AgentRegistrationConfig } from '../../src/identity/types.js';

// Mock ethers module
vi.mock('ethers', () => {
  const mockContract = {
    register: vi.fn(),
    balanceOf: vi.fn(),
    tokenURI: vi.fn(),
    ownerOf: vi.fn(),
    setAgentURI: vi.fn(),
    filters: {
      Transfer: vi.fn().mockReturnValue('transfer-filter'),
    },
    queryFilter: vi.fn().mockResolvedValue([]),
  };

  // getNetwork/getFeeData are read by AgentRegistration.getGasOverrides() before
  // every write TX — the chain decides whether gas is auto-estimated (Base) or
  // set explicitly (Ethereum). A provider double missing them makes every write
  // path throw instead of exercising that branch.
  const mockProvider = {
    getBlockNumber: vi.fn().mockResolvedValue(1000),
    getTransactionCount: vi.fn().mockResolvedValue(0),
    getNetwork: vi.fn().mockResolvedValue({ chainId: 84532n }), // matches chainRpcUrl below
    getFeeData: vi.fn().mockResolvedValue({
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasPrice: 2_000_000_000n,
    }),
  };

  const mockWallet = {
    address: '0x1234567890123456789012345678901234567890',
  };

  return {
    ethers: {
      JsonRpcProvider: vi.fn(() => mockProvider),
      Wallet: vi.fn(() => mockWallet),
      Contract: vi.fn(() => mockContract),
      zeroPadValue: vi.fn((addr: string) => addr.padEnd(66, '0')),
    },
  };
});

describe('AgentRegistration', () => {
  let AgentRegistration: any;
  let createMetadataUri: any;
  let mockContract: any;
  let mockProvider: any;

  const validConfig: AgentRegistrationConfig = {
    identityContractAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    chainRpcUrl: 'https://sepolia.base.org',
    privateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
  };

  const validMetadata: AgentMetadata = {
    name: 'Test Agent',
    description: 'Test description',
    agentUrl: 'https://ai.zkproofport.app',
    capabilities: ['generate_proof'],
    protocols: ['mcp'],
    circuits: ['coinbase_attestation'],
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Dynamic import to get fresh mocked module
    const module = await import('../../src/identity/register.js');
    AgentRegistration = module.AgentRegistration;
    createMetadataUri = module.createMetadataUri;

    // Get mock contract / provider instances
    const { ethers } = await import('ethers');
    mockContract = new ethers.Contract('', [], null);
    mockProvider = new ethers.JsonRpcProvider('');
    mockProvider.getNetwork.mockResolvedValue({ chainId: 84532n });
  });

  describe('Constructor', () => {
    it('should create instance with valid config', () => {
      const registration = new AgentRegistration(validConfig);
      expect(registration).toBeDefined();
      expect(registration.agentAddress).toBe('0x1234567890123456789012345678901234567890');
    });

    it('should throw if identityContractAddress missing', () => {
      const invalidConfig = { ...validConfig, identityContractAddress: '' };
      expect(() => new AgentRegistration(invalidConfig)).toThrow();
    });

    it('should throw if reputationContractAddress missing', () => {
      const invalidConfig = { ...validConfig, reputationContractAddress: '' };
      expect(() => new AgentRegistration(invalidConfig)).toThrow();
    });

    it('should throw if chainRpcUrl missing', () => {
      const invalidConfig = { ...validConfig, chainRpcUrl: '' };
      expect(() => new AgentRegistration(invalidConfig)).toThrow();
    });

    it('should throw if privateKey missing', () => {
      const invalidConfig = { ...validConfig, privateKey: '' };
      expect(() => new AgentRegistration(invalidConfig)).toThrow();
    });
  });

  describe('register()', () => {
    it('should call contract.register with correct metadataURI', async () => {
      const registration = new AgentRegistration(validConfig);

      // Mock transaction receipt with logs
      const mockReceipt = {
        logs: [
          {
            topics: ['0xevent', '0xfrom', '0xto', '0x0000000000000000000000000000000000000000000000000000000000000001'],
            data: '0x',
          },
        ],
        hash: '0xtxhash123',
      };

      mockContract.register.mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      });

      const result = await registration.register(validMetadata);

      expect(mockContract.register).toHaveBeenCalledTimes(1);
      const [calledUri, overrides] = mockContract.register.mock.calls[0];
      expect(calledUri).toContain('data:application/json;base64,');
      // Base chains auto-estimate gas — only the locally tracked nonce is sent.
      expect(overrides).toEqual({ nonce: 0 });
      expect(result.tokenId).toBe(1n);
      expect(result.transactionHash).toBe('0xtxhash123');
      expect(result.agentAddress).toBe('0x1234567890123456789012345678901234567890');
    });

    it('should set an explicit gasLimit and boosted fees on Ethereum', async () => {
      mockProvider.getNetwork.mockResolvedValue({ chainId: 1n });
      const registration = new AgentRegistration(validConfig);

      mockContract.register.mockResolvedValue({
        wait: vi.fn().mockResolvedValue({
          logs: [{ topics: ['0xevent', '0xfrom', '0xto', '0x' + '0'.repeat(63) + '1'], data: '0x' }],
          hash: '0xtxhash',
        }),
      });

      await registration.register(validMetadata);

      const overrides = mockContract.register.mock.calls[0][1];
      const uriLength = mockContract.register.mock.calls[0][0].length;
      // Ethereum skips eth_estimateGas (slow on large calldata) and computes it.
      expect(overrides.gasLimit).toBe(21000 + uriLength * 16 + 2200000);
      // Fees are boosted 20% over feeData for faster inclusion.
      expect(overrides.maxFeePerGas).toBe(2_000_000_000n * 120n / 100n);
      expect(overrides.maxPriorityFeePerGas).toBe(1_000_000_000n * 120n / 100n);
    });

    it('should extract tokenId from receipt logs', async () => {
      const registration = new AgentRegistration(validConfig);

      const mockReceipt = {
        logs: [
          {
            topics: ['0xevent', '0xfrom', '0xto', '0x000000000000000000000000000000000000000000000000000000000000002a'],
            data: '0x',
          },
        ],
        hash: '0xtxhash',
      };

      mockContract.register.mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      });

      const result = await registration.register(validMetadata);
      expect(result.tokenId).toBe(42n);
    });

    it('should handle transaction failure', async () => {
      const registration = new AgentRegistration(validConfig);

      mockContract.register.mockRejectedValue(new Error('Transaction failed'));

      await expect(registration.register(validMetadata)).rejects.toThrow('Transaction failed');
    });

    it('should handle missing logs in receipt', async () => {
      const registration = new AgentRegistration(validConfig);

      const mockReceipt = {
        logs: [],
        hash: '0xtxhash',
      };

      mockContract.register.mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      });

      await expect(registration.register(validMetadata)).rejects.toThrow();
    });
  });

  describe('isRegistered()', () => {
    it('should return true when balanceOf > 0', async () => {
      const registration = new AgentRegistration(validConfig);
      mockContract.balanceOf.mockResolvedValue(1n);

      const result = await registration.isRegistered();
      expect(result).toBe(true);
      expect(mockContract.balanceOf).toHaveBeenCalledWith('0x1234567890123456789012345678901234567890');
    });

    it('should return false when balanceOf = 0', async () => {
      const registration = new AgentRegistration(validConfig);
      mockContract.balanceOf.mockResolvedValue(0n);

      const result = await registration.isRegistered();
      expect(result).toBe(false);
    });

    it('should handle contract call failure', async () => {
      const registration = new AgentRegistration(validConfig);
      mockContract.balanceOf.mockRejectedValue(new Error('RPC error'));

      await expect(registration.isRegistered()).rejects.toThrow('RPC error');
    });
  });

  describe('getRegistration()', () => {
    it('should return info when registered', async () => {
      const registration = new AgentRegistration(validConfig);
      mockContract.balanceOf.mockResolvedValue(1n);

      const result = await registration.getRegistration();

      expect(result).not.toBeNull();
      // findTokenId returns null (no events in mock) → fallback with tokenId: 0n
      expect(result?.tokenId).toBe(0n);
      expect(result?.owner).toBe('0x1234567890123456789012345678901234567890');
      expect(result?.isRegistered).toBe(true);
    });

    it('should return null when not registered', async () => {
      const registration = new AgentRegistration(validConfig);
      mockContract.balanceOf.mockResolvedValue(0n);

      const result = await registration.getRegistration();
      expect(result).toBeNull();
    });

    it('should handle contract call failure', async () => {
      const registration = new AgentRegistration(validConfig);
      mockContract.balanceOf.mockRejectedValue(new Error('Contract error'));

      await expect(registration.getRegistration()).rejects.toThrow('Contract error');
    });
  });

  describe('agentAddress getter', () => {
    it('should return signer address', () => {
      const registration = new AgentRegistration(validConfig);
      expect(registration.agentAddress).toBe('0x1234567890123456789012345678901234567890');
    });
  });

  describe('createMetadataUri()', () => {
    it('should generate valid data URI with correct JSON', () => {
      const uri = createMetadataUri(validMetadata);

      expect(uri).toContain('data:application/json;base64,');

      // Decode and verify JSON
      const base64 = uri.split('data:application/json;base64,')[1];
      const decoded = Buffer.from(base64, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);

      expect(parsed.name).toBe('Test Agent');
      expect(parsed.description).toBe('Test description');
      expect(parsed.agentUrl).toBe('https://ai.zkproofport.app');
      expect(parsed.capabilities).toEqual(['generate_proof']);
      expect(parsed.protocols).toEqual(['mcp']);
      expect(parsed.circuits).toEqual(['coinbase_attestation']);
    });

    it('should include all required fields in metadata', () => {
      const uri = createMetadataUri(validMetadata);
      const base64 = uri.split('data:application/json;base64,')[1];
      const decoded = Buffer.from(base64, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);

      expect(parsed).toHaveProperty('name');
      expect(parsed).toHaveProperty('description');
      expect(parsed).toHaveProperty('agentUrl');
      expect(parsed).toHaveProperty('capabilities');
      expect(parsed).toHaveProperty('protocols');
      expect(parsed).toHaveProperty('circuits');
    });

    it('should include optional tee field when present', () => {
      const metadataWithTee = { ...validMetadata, tee: 'aws-nitro' };
      const uri = createMetadataUri(metadataWithTee);
      const base64 = uri.split('data:application/json;base64,')[1];
      const decoded = Buffer.from(base64, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);

      expect(parsed.tee).toBe('aws-nitro');
    });

    it('should omit tee field when not present', () => {
      const uri = createMetadataUri(validMetadata);
      const base64 = uri.split('data:application/json;base64,')[1];
      const decoded = Buffer.from(base64, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);

      expect(parsed).not.toHaveProperty('tee');
    });

    it('should handle empty arrays', () => {
      const minimalMetadata: AgentMetadata = {
        name: 'Minimal',
        description: 'Minimal agent',
        agentUrl: 'https://example.com',
        capabilities: [],
        protocols: [],
        circuits: [],
      };

      const uri = createMetadataUri(minimalMetadata);
      const base64 = uri.split('data:application/json;base64,')[1];
      const decoded = Buffer.from(base64, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);

      expect(parsed.capabilities).toEqual([]);
      expect(parsed.protocols).toEqual([]);
      expect(parsed.circuits).toEqual([]);
    });
  });
});
