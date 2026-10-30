/**
 * The AI SDK's human_passport path: no network, the threshold refused before
 * anything is signed, the wallet + circuit-tag nullifier, the key recovered
 * from what was actually signed, and verifyProof passing the threshold to core.
 *
 * Matrix: minScore 0 / -1 / NaN / '20' / 5 decimals / missing refused before
 * signing; minScore on another circuit refused; signature by another wallet
 * refused; action mode recovers from the EIP-712 digest; no fetch at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { prepareHumanPassportInputs, computeWalletNullifier, computeScope } from '../packages/sdk/src/inputs.js';
import { generateProof } from '../packages/sdk/src/flow.js';

const wallet = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('ai sdk human passport wallet')));
const config = { baseUrl: 'https://proof.invalid' };

afterEach(() => vi.restoreAllMocks());

describe('prepareHumanPassportInputs', () => {
  it('sends the signed request and the threshold, fetching nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { computeSignalHash } = await import('../packages/sdk/src/inputs.js');
    const signal = computeSignalHash(wallet.address, 'my-app', 'human_passport_score');
    const out = prepareHumanPassportInputs({ userAddress: wallet.address, userSignature: await wallet.signMessage(signal), scope: 'my-app', minScore: 20 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.min_score).toBe(20);
    expect(out.nullifier).toBe(ethers.hexlify(computeWalletNullifier(wallet.address, 'human_passport_score', computeScope('my-app'))));
    expect(out.domain_separator).toBeUndefined();
    expect(ethers.computeAddress('0x04' + out.user_pubkey_x.slice(2) + out.user_pubkey_y.slice(2))).toBe(wallet.address);
  });

  it('recovers the key from the EIP-712 digest in action mode', async () => {
    const domain = { name: 'Vault', version: '1', chainId: 8453, verifyingContract: '0x' + '33'.repeat(20) };
    const types = { Deposit: [{ name: 'amount', type: 'uint256' }] };
    const signature = await wallet.signTypedData(domain, types, { amount: 1n });
    const out = prepareHumanPassportInputs({
      userAddress: wallet.address, userSignature: signature, scope: 'my-app', minScore: 20,
      domainSeparator: ethers.TypedDataEncoder.hashDomain(domain), actionHash: ethers.TypedDataEncoder.from(types).hash({ amount: 1n }),
    });
    expect(out.domain_separator).toBe(ethers.TypedDataEncoder.hashDomain(domain));
  });

  it('refuses a signature made by another wallet', async () => {
    const other = ethers.Wallet.createRandom();
    const userSignature = await other.signMessage('x');
    expect(() => prepareHumanPassportInputs({ userAddress: wallet.address, userSignature, scope: 'a', minScore: 20 }))
      .toThrow(/not made by/);
  });
});

describe('generateProof refuses a bad threshold before signing', () => {
  it.each([0, -1, NaN, '20', 20.00001, undefined])('minScore %p', async bad => {
    const signer = { getAddress: vi.fn(async () => wallet.address), signMessage: vi.fn() };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(generateProof(config, { attestation: signer as never }, { circuit: 'human_passport', minScore: bad as never }))
      .rejects.toThrow(/minScore/);
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses minScore on a circuit that has no threshold', async () => {
    const signer = { getAddress: vi.fn(async () => wallet.address), signMessage: vi.fn() };
    await expect(generateProof(config, { attestation: signer as never }, { circuit: 'coinbase_kyc', minScore: 20 }))
      .rejects.toThrow(/applies only to human_passport/);
    expect(signer.signMessage).not.toHaveBeenCalled();
  });
});
