import { afterEach, describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { computeCircuitParams, computeSignalHash, recoverUserPubkeyFromDigest, eip712Digest } from '../src/input/inputBuilder.js';
import { ATTESTATION_SOURCES } from '../src/config/contracts.js';
const fixture = vi.hoisted(() => ({ attesterAddress: '', attesterPublicKey: '' }));
vi.mock('../src/input/attestationFetcher.js', () => ({
  fetchAttestationData: async () => ({ rawTransaction: '0x01' }),
  recoverAttesterPubkey: () => fixture.attesterPublicKey,
  getSignerAddress: () => fixture.attesterAddress,
}));
vi.mock('../src/input/giwaAttestation.js', () => ({ findGiwaAttestation: async () => ({ rawTransaction: '0x01' }) }));
afterEach(() => vi.unstubAllEnvs());
const wallet = new ethers.Wallet('0x' + '11'.repeat(32));
const digest = ethers.getBytes('0x' + '22'.repeat(32));
describe('server witness signature recovery follows action presence', () => {
  it('recovers personal-sign identity signatures including action-capable circuits', async () => {
    const signature = await wallet.signMessage(digest);
    expect(recoverUserPubkeyFromDigest(digest, signature, false)).toBe(wallet.signingKey.publicKey);
  });
  it('recovers typed action signatures for both Arc and GIWA without adding personal-sign prefix', () => {
    const signature = wallet.signingKey.sign(digest).serialized;
    expect(recoverUserPubkeyFromDigest(digest, signature, true)).toBe(wallet.signingKey.publicKey);
  });
  it('describes missing EIP-712 hashes without claiming Arc always requires actions', () => {
    expect(() => eip712Digest()).toThrow(/both domainSeparator and actionHash/);
  });
});


describe('full server input preparation preserves each action mode', () => {
  for (const circuitId of ['arc_eligibility', 'giwa_attestation'] as const) {
    it.each([false, true])(`${circuitId} recovers the actual wallet with action=%s`, async hasAction => {
      fixture.attesterAddress = ATTESTATION_SOURCES[circuitId]!.signers[0];
      fixture.attesterPublicKey = wallet.signingKey.publicKey;
      vi.stubEnv('GIWA_RPC_URL', 'https://giwa.example.com');
      vi.stubEnv('GIWA_EXPLORER_URL', 'https://explorer.example.com');
      const scope = 'recovery-mode-test';
      const domainSeparator = '0x' + '33'.repeat(32);
      const actionHash = '0x' + '44'.repeat(32);
      const signalHash = computeSignalHash(wallet.address, scope, circuitId);
      const signature = hasAction
        ? wallet.signingKey.sign(eip712Digest(domainSeparator, actionHash)).serialized
        : await wallet.signMessage(signalHash);
      const result = await computeCircuitParams({ address: wallet.address, scope, circuitId, signature,
        ...(hasAction ? { domainSeparator, actionHash } : {}),
      }, 'https://eas.example.com', ['https://base.example.com']);
      expect(`0x04${result.userPubkeyX.replace(/^0x/, '')}${result.userPubkeyY.replace(/^0x/, '')}`).toBe(wallet.signingKey.publicKey);
    });
  }
});
