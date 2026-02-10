import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ethers before importing the module under test
vi.mock('ethers', () => {
  const mockVerify = vi.fn();
  const mockContract = vi.fn().mockImplementation(() => ({
    verify: mockVerify,
  }));
  const mockJsonRpcProvider = vi.fn().mockImplementation(() => ({}));

  return {
    ethers: {
      JsonRpcProvider: mockJsonRpcProvider,
      Contract: mockContract,
    },
    // Re-export for named imports
    JsonRpcProvider: mockJsonRpcProvider,
    Contract: mockContract,
  };
});

import { ethers } from 'ethers';
import { verifyOnChain } from '../src/prover/verifier.js';
import { VERIFIER_ADDRESSES } from '../src/config/contracts.js';

describe('verifyOnChain', () => {
  const mockVerifyFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock Contract to return our mockVerifyFn
    (ethers.Contract as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      verify: mockVerifyFn,
    }));
  });

  it('should return isValid: true when on-chain verification succeeds', async () => {
    mockVerifyFn.mockResolvedValue(true);

    const result = await verifyOnChain({
      proof: '0xaabbccdd',
      publicInputs: ['0x1111', '0x2222'],
      circuitId: 'coinbase_attestation',
      chainId: '84532',
      rpcUrl: 'https://sepolia.base.org',
    });

    expect(result.isValid).toBe(true);
    expect(result.verifierAddress).toBe(
      VERIFIER_ADDRESSES['84532']['coinbase_attestation']
    );

    // Verify JsonRpcProvider was called with the rpcUrl
    expect(ethers.JsonRpcProvider).toHaveBeenCalledWith('https://sepolia.base.org');

    // Verify Contract was instantiated with the correct verifier address
    expect(ethers.Contract).toHaveBeenCalledWith(
      VERIFIER_ADDRESSES['84532']['coinbase_attestation'],
      expect.any(Array),
      expect.any(Object),
    );

    // Verify the verify function was called with proof and publicInputs
    expect(mockVerifyFn).toHaveBeenCalledWith('0xaabbccdd', ['0x1111', '0x2222']);
  });

  it('should return isValid: false when on-chain verification fails', async () => {
    mockVerifyFn.mockResolvedValue(false);

    const result = await verifyOnChain({
      proof: '0xbadproof',
      publicInputs: ['0x0000'],
      circuitId: 'coinbase_attestation',
      chainId: '84532',
      rpcUrl: 'https://sepolia.base.org',
    });

    expect(result.isValid).toBe(false);
    expect(result.verifierAddress).toBe(
      VERIFIER_ADDRESSES['84532']['coinbase_attestation']
    );
  });

  it('should work with coinbase_country_attestation circuit', async () => {
    mockVerifyFn.mockResolvedValue(true);

    const result = await verifyOnChain({
      proof: '0xdeadbeef',
      publicInputs: ['0xaaaa', '0xbbbb', '0xcccc'],
      circuitId: 'coinbase_country_attestation',
      chainId: '84532',
      rpcUrl: 'https://sepolia.base.org',
    });

    expect(result.isValid).toBe(true);
    expect(result.verifierAddress).toBe(
      VERIFIER_ADDRESSES['84532']['coinbase_country_attestation']
    );
  });

  it('should throw for unknown circuitId', async () => {
    await expect(
      verifyOnChain({
        proof: '0xaabbccdd',
        publicInputs: ['0x1111'],
        circuitId: 'unknown_circuit',
        chainId: '84532',
        rpcUrl: 'https://sepolia.base.org',
      })
    ).rejects.toThrow('No verifier found for circuit "unknown_circuit" on chain "84532"');
  });

  it('should throw for unknown chainId', async () => {
    await expect(
      verifyOnChain({
        proof: '0xaabbccdd',
        publicInputs: ['0x1111'],
        circuitId: 'coinbase_attestation',
        chainId: '99999',
        rpcUrl: 'https://sepolia.base.org',
      })
    ).rejects.toThrow('No verifier found for circuit "coinbase_attestation" on chain "99999"');
  });

  it('should throw when contract call reverts', async () => {
    mockVerifyFn.mockRejectedValue(new Error('execution reverted'));

    await expect(
      verifyOnChain({
        proof: '0xbaddata',
        publicInputs: ['0x1111'],
        circuitId: 'coinbase_attestation',
        chainId: '84532',
        rpcUrl: 'https://sepolia.base.org',
      })
    ).rejects.toThrow('On-chain verification failed: execution reverted');
  });

  it('should throw when RPC connection fails', async () => {
    mockVerifyFn.mockRejectedValue(new Error('could not detect network'));

    await expect(
      verifyOnChain({
        proof: '0xaabbccdd',
        publicInputs: ['0x1111'],
        circuitId: 'coinbase_attestation',
        chainId: '84532',
        rpcUrl: 'https://bad-rpc.example.com',
      })
    ).rejects.toThrow('On-chain verification failed: could not detect network');
  });
});
