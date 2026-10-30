import { beforeEach, describe, expect, it, vi } from 'vitest';

// What the AI SDK hands core, and what it builds the provider from. Core's
// verifyProofOnChain and ethers' provider are mocked; the refusals themselves
// run against the real core in sdkVerifyUsesPinnedVerifier.test.ts.
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>();
  const JsonRpcProvider = vi.fn().mockImplementation((url: string) => ({ kind: 'provider', url }));
  return { ...actual, ethers: { ...actual.ethers, JsonRpcProvider }, JsonRpcProvider };
});
vi.mock('@zkproofport-app/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zkproofport-app/core')>();
  return { ...actual, verifyProofOnChain: vi.fn() };
});

import { ethers } from 'ethers';
import { PINNED_VERIFIERS, verifyProofOnChain } from '@zkproofport-app/core';
import { verifyProof } from '../packages/sdk/src/verify.js';
import type { ProveResponse } from '../packages/sdk/src/types.js';

const coreVerify = vi.mocked(verifyProofOnChain);
const ADDRESS = PINNED_VERIFIERS.coinbase_attestation[84532].address;

function response(verification: ProveResponse['verification']): ProveResponse {
  return {
    circuit: 'coinbase_attestation', proofType: 'kyc', proof: '0xaabb',
    publicInputs: '0x' + '11'.repeat(32) + '22'.repeat(32),
    proofWithInputs: '', attestation: null, timing: { totalMs: 0 }, verification,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('AI SDK verifyProof -> core', () => {
  it('names the chain for the pinned verifier and passes the response address only as a claim', async () => {
    coreVerify.mockResolvedValue({ valid: true });
    const result = await verifyProof(response({ chainId: 84532, verifierAddress: ADDRESS, rpcUrl: 'https://sepolia.base.org' }));

    expect(result).toEqual({ valid: true });
    expect(coreVerify).toHaveBeenCalledOnce();
    expect(coreVerify).toHaveBeenCalledWith(
      'coinbase_attestation',
      { proofHex: '0xaabb', publicInputsHex: ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)], numPublicInputs: 2 },
      { kind: 'provider', url: 'https://sepolia.base.org' },
      { chainId: 84532 },
      { verifierAddress: ADDRESS, chainId: 84532 },
    );
  });

  it("never builds the provider from the response's rpcUrl", async () => {
    coreVerify.mockResolvedValue({ valid: true });
    await verifyProof(response({ chainId: 11155111, verifierAddress: ADDRESS, rpcUrl: 'https://rpc.attacker.example' }));
    expect(ethers.JsonRpcProvider).toHaveBeenCalledOnce();
    expect(ethers.JsonRpcProvider).toHaveBeenCalledWith('https://ethereum-sepolia-rpc.publicnode.com', 11155111, { staticNetwork: true });
  });

  it('does not reach core for a chain with no RPC', async () => {
    const result = await verifyProof(response({ chainId: 5, verifierAddress: ADDRESS }));
    expect(result.valid).toBe(false);
    expect(coreVerify).not.toHaveBeenCalled();
    expect(ethers.JsonRpcProvider).not.toHaveBeenCalled();
  });

  it('reports core refusing (or a revert) as not valid, with the reason', async () => {
    coreVerify.mockResolvedValue({ valid: false, error: 'execution reverted' });
    const result = await verifyProof(response({ chainId: 84532, verifierAddress: ADDRESS }));
    expect(result).toEqual({ valid: false, error: 'Verification failed: execution reverted' });
  });

  it('reports a contract that answers false as not valid', async () => {
    coreVerify.mockResolvedValue({ valid: false });
    expect(await verifyProof(response({ chainId: 84532, verifierAddress: ADDRESS }))).toEqual({ valid: false });
  });
});

describe('AI SDK verifyProof passes a Human Passport threshold to core', () => {
  it('hands core the minScore it was given, and nothing when none was given', async () => {
    coreVerify.mockResolvedValue({ valid: true });
    const hp = { ...response({ chainId: 84532, verifierAddress: ADDRESS }), circuit: 'human_passport_score' };
    await verifyProof(hp, { minScore: 20 });
    expect(coreVerify.mock.calls[0][5]).toEqual({ minScore: 20 });
    await verifyProof(hp);
    expect(coreVerify.mock.calls[1]).toHaveLength(5);
  });
});
