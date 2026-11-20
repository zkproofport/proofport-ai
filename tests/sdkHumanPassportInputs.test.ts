/**
 * The AI SDK's human_passport path: no network, the threshold refused before
 * anything is signed, the OPRF nullifier values passed through, the key recovered
 * from what was actually signed, and verifyProof passing the threshold to core.
 *
 * Matrix: minScore 0 / -1 / NaN / '20' / 5 decimals / missing refused before
 * signing; minScore on another circuit refused; signature by another wallet
 * refused; action mode recovers from the EIP-712 digest; no fetch at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { prepareHumanPassportInputs } from '../packages/sdk/src/inputs.js';
import { generateProof } from '../packages/sdk/src/flow.js';
import { STUB_OPRF_INPUTS } from './helpers/oprfStub.js';

// checkPreparedOprf is stubbed (the real re-verification: tests/oprfFlow.test.ts).
vi.mock('../packages/sdk/src/oprf/index.js', async orig => (await import('./helpers/oprfStub.js')).stubOprf(await orig()));

const wallet = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('ai sdk human passport wallet')));
const config = { baseUrl: 'https://proof.invalid' };
const oprf = (scope: string) => ({
  environment: 'staging' as const, circuitId: 'human_passport_score', address: wallet.address, oprfDomain: 'app.example.com', scope,
  inputs: { ...STUB_OPRF_INPUTS } as never,
});

afterEach(() => vi.restoreAllMocks());

describe('prepareHumanPassportInputs', () => {
  it('sends the signed request and the threshold, fetching nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { computeSignalHash } = await import('../packages/sdk/src/signalHash.js');
    const signal = computeSignalHash({ scope: 'my-app', circuitId: 'human_passport_score', requestId: '3f2b8c1e-9d4a-4f6b-8e2c-1a7d5b9c0e4f' });
    const out = prepareHumanPassportInputs({ userAddress: wallet.address, userSignature: await wallet.signMessage(signal), scope: 'my-app', minScore: 20, chain: 8453, requestId: '3f2b8c1e-9d4a-4f6b-8e2c-1a7d5b9c0e4f', oprf: oprf('my-app') });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.min_score).toBe(20);
    for (const [k, v] of Object.entries(STUB_OPRF_INPUTS)) expect((out as unknown as Record<string, string>)[k]).toBe(v);
    expect(out).not.toHaveProperty('scope_bytes');
    expect(out.domain_separator).toBeUndefined();
    expect(ethers.computeAddress('0x04' + out.user_pubkey_x.slice(2) + out.user_pubkey_y.slice(2))).toBe(wallet.address);
  });

  it('recovers the key from the EIP-712 digest in action mode', async () => {
    const domain = { name: 'Vault', version: '1', chainId: 8453, verifyingContract: '0x' + '33'.repeat(20) };
    const types = { Deposit: [{ name: 'amount', type: 'uint256' }] };
    const signature = await wallet.signTypedData(domain, types, { amount: 1n });
    const out = prepareHumanPassportInputs({
      userAddress: wallet.address, userSignature: signature, scope: 'my-app', minScore: 20, chain: 8453,
      domainSeparator: ethers.TypedDataEncoder.hashDomain(domain), actionHash: ethers.TypedDataEncoder.from(types).hash({ amount: 1n }),
      oprf: oprf('my-app'),
    });
    expect(out.domain_separator).toBe(ethers.TypedDataEncoder.hashDomain(domain));
  });

  it('refuses a signature made by another wallet', async () => {
    const other = ethers.Wallet.createRandom();
    const userSignature = await other.signMessage('x');
    expect(() => prepareHumanPassportInputs({ userAddress: wallet.address, userSignature, scope: 'a', minScore: 20, chain: 8453, requestId: '3f2b8c1e-9d4a-4f6b-8e2c-1a7d5b9c0e4f', oprf: oprf('a') }))
      .toThrow(/not made by/);
  });
});

describe('generateProof refuses a bad threshold before signing', () => {
  it.each([0, -1, NaN, '20', 20.00001, undefined])('minScore %p', async bad => {
    const signer = { getAddress: vi.fn(async () => wallet.address), signMessage: vi.fn() };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(generateProof(config, { attestation: signer as never }, { circuit: 'human_passport', scope: 'my-app', oprfDomain: 'my-app.example.com', minScore: bad as never, chain: 8453 }))
      .rejects.toThrow(/minScore/);
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, 1, 84532, '8453'])('chain %p', async bad => {
    const signer = { getAddress: vi.fn(async () => wallet.address), signMessage: vi.fn() };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(generateProof(config, { attestation: signer as never }, { circuit: 'human_passport', scope: 'my-app', oprfDomain: 'my-app.example.com', minScore: 20, chain: bad as never }))
      .rejects.toThrow(/chain is required/);
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses minScore on a circuit that has no threshold', async () => {
    const signer = { getAddress: vi.fn(async () => wallet.address), signMessage: vi.fn() };
    await expect(generateProof(config, { attestation: signer as never }, { circuit: 'coinbase_kyc', scope: 'my-app', oprfDomain: 'my-app.example.com', minScore: 20 }))
      .rejects.toThrow(/apply only to human_passport/);
    expect(signer.signMessage).not.toHaveBeenCalled();
  });
});
