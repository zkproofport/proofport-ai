import { describe, it, expect, vi, beforeEach } from 'vitest';

// The provider is built here from the caller's rpcUrl; the contract call is
// @zkproofport-app/core's verifyProofOnChain. Both are mocked so the test
// asserts what this module hands to core and how it reports core's answer.
vi.mock('ethers', () => {
  const mockJsonRpcProvider = vi.fn().mockImplementation(() => ({ kind: 'provider' }));
  return {
    ethers: { JsonRpcProvider: mockJsonRpcProvider },
    JsonRpcProvider: mockJsonRpcProvider,
  };
});

vi.mock('@zkproofport-app/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zkproofport-app/core')>();
  return { ...actual, verifyProofOnChain: vi.fn() };
});

import { ethers } from 'ethers';
import { VERIFIER_ABI, verifyProofOnChain } from '@zkproofport-app/core';
import { verifyOnChain } from '../src/prover/verifier.js';
import { FALLBACK_VERIFIERS } from '../src/config/contracts.js';

const coreVerify = verifyProofOnChain as unknown as ReturnType<typeof vi.fn>;

describe('verifyOnChain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return isValid: true when on-chain verification succeeds', async () => {
    coreVerify.mockResolvedValue({ valid: true });

    const result = await verifyOnChain({
      proof: '0xaabbccdd',
      publicInputs: ['0x1111', '0x2222'],
      circuitId: 'coinbase_attestation',
      chainId: '84532',
      rpcUrl: 'https://sepolia.base.org',
    });

    expect(result.isValid).toBe(true);
    expect(result.verifierAddress).toBe(
      FALLBACK_VERIFIERS['84532']['coinbase_attestation']
    );

    // Verify JsonRpcProvider was called with the rpcUrl
    expect(ethers.JsonRpcProvider).toHaveBeenCalledWith('https://sepolia.base.org');

    // Core is called with the proof and public inputs unchanged (no padding),
    // the provider built from rpcUrl, and the looked-up verifier on that chain.
    expect(coreVerify).toHaveBeenCalledTimes(1);
    expect(coreVerify).toHaveBeenCalledWith(
      'coinbase_attestation',
      { proofHex: '0xaabbccdd', publicInputsHex: ['0x1111', '0x2222'], numPublicInputs: 2 },
      { kind: 'provider' },
      {
        address: FALLBACK_VERIFIERS['84532']['coinbase_attestation'],
        chainId: 84532,
        abi: VERIFIER_ABI,
      },
    );
  });

  it('should return isValid: false when on-chain verification fails', async () => {
    coreVerify.mockResolvedValue({ valid: false });

    const result = await verifyOnChain({
      proof: '0xbadproof',
      publicInputs: ['0x0000'],
      circuitId: 'coinbase_attestation',
      chainId: '84532',
      rpcUrl: 'https://sepolia.base.org',
    });

    expect(result.isValid).toBe(false);
    expect(result.verifierAddress).toBe(
      FALLBACK_VERIFIERS['84532']['coinbase_attestation']
    );
  });

  it('should work with coinbase_country_attestation circuit', async () => {
    coreVerify.mockResolvedValue({ valid: true });

    const result = await verifyOnChain({
      proof: '0xdeadbeef',
      publicInputs: ['0xaaaa', '0xbbbb', '0xcccc'],
      circuitId: 'coinbase_country_attestation',
      chainId: '84532',
      rpcUrl: 'https://sepolia.base.org',
    });

    expect(result.isValid).toBe(true);
    expect(result.verifierAddress).toBe(
      FALLBACK_VERIFIERS['84532']['coinbase_country_attestation']
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
    expect(coreVerify).not.toHaveBeenCalled();
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
    expect(coreVerify).not.toHaveBeenCalled();
  });

  it('should throw when contract call reverts', async () => {
    coreVerify.mockResolvedValue({ valid: false, error: 'execution reverted' });

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
    coreVerify.mockResolvedValue({ valid: false, error: 'could not detect network' });

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
