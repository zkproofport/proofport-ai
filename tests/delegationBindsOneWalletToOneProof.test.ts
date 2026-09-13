import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  buildDelegationAction,
  delegationActionHash,
  delegationDomainSeparator,
  delegationMatchesProof,
  delegateOf,
  DELEGATION_PRIMARY_TYPE,
} from '../packages/sdk/src/delegation.js';
import { validateTypedAction } from '../packages/sdk/src/typedAction.js';

/**
 * A delegation lets wallet B act on wallet A's KYC while A stays hidden — and
 * it must be impossible to move that proof onto a different B.
 *
 * The proof carries the delegation's hash as a public input, so a service that
 * rebuilds the hash from what it was shown cannot be handed a valid proof
 * alongside a delegation naming somebody else. A service that skips that
 * rebuild can, which is the whole reason `delegationMatchesProof` exists.
 */
const domain = {
  name: 'Ledger House Staking',
  version: '1',
  chainId: 5042002,
  verifyingContract: '0xCbC8E63fF92659E8B44cFF117D33005Bb669a018',
};
const B = '0xf3Be236D3e267A188909Ce98e9112a020ac2Ed13';
const someoneElse = '0x000000000000000000000000000000000000dEaD';
const soon = Math.floor(Date.now() / 1000) + 3600;

const delegation = { delegate: B, action: 'stake', expiresAt: soon, nonce: 'demo-1' };
const action = buildDelegationAction({ delegation, domain });
const proofInputs = {
  domainSeparator: delegationDomainSeparator(action),
  actionHash: delegationActionHash(action),
};

describe('a delegation binds one wallet to one proof', () => {
  it('is an ordinary action the circuit already accepts', () => {
    expect(validateTypedAction(action)).toBeNull();
    expect(action.primaryType).toBe(DELEGATION_PRIMARY_TYPE);
  });

  it('names the delegate, and the KYC wallet appears nowhere in it', () => {
    expect(delegateOf(action)).toBe(B);
    expect(JSON.stringify(action)).not.toContain('0x1111111111111111111111111111111111111111');
  });

  it('accepts the proof that was made for it', () => {
    expect(delegationMatchesProof({ action, ...proofInputs })).toBeNull();
  });

  it('refuses the same proof shown with a delegation naming someone else', () => {
    // The attack: take a valid proof, present it with your own address.
    const swapped = buildDelegationAction({ delegation: { ...delegation, delegate: someoneElse }, domain });
    expect(delegationMatchesProof({ action: swapped, ...proofInputs }))
      .toMatch(/made for a different delegation/);
  });

  it('refuses a delegation issued for another service', () => {
    const elsewhere = buildDelegationAction({
      delegation,
      domain: { ...domain, name: 'Some Other Vault' },
    });
    expect(delegationMatchesProof({ action: elsewhere, actionHash: delegationActionHash(elsewhere), domainSeparator: proofInputs.domainSeparator }))
      .toMatch(/different service/);
  });

  it('refuses an expired delegation even when the proof is sound', () => {
    const old = buildDelegationAction({ delegation: { ...delegation, expiresAt: 1 }, domain });
    expect(delegationMatchesProof({
      action: old,
      domainSeparator: delegationDomainSeparator(old),
      actionHash: delegationActionHash(old),
    })).toMatch(/expired/);
  });

  it('refuses an action that authorises something other than a delegation', () => {
    const deposit = {
      domain,
      types: { Deposit: [{ name: 'amount', type: 'uint256' }] },
      primaryType: 'Deposit',
      message: { amount: '1' },
    };
    expect(delegationMatchesProof({ action: deposit, ...proofInputs })).toMatch(/not a CredentialDelegation/);
  });

  it('refuses to build a delegation that says nothing useful', () => {
    expect(() => buildDelegationAction({ delegation: { ...delegation, delegate: '0x01' }, domain })).toThrow(/must be an address/);
    expect(() => buildDelegationAction({ delegation: { ...delegation, action: '  ' }, domain })).toThrow(/what the delegate may do/);
    expect(() => buildDelegationAction({ delegation: { ...delegation, expiresAt: 0 }, domain })).toThrow(/without an end/);
    expect(() => buildDelegationAction({ delegation: { ...delegation, nonce: '' }, domain })).toThrow(/replayed/);
  });

  it('is what a wallet actually signs, and recovery returns the KYC wallet', async () => {
    const a = ethers.Wallet.createRandom();
    const signature = await a.signTypedData(action.domain, action.types, action.message);
    const digest = ethers.keccak256(ethers.concat(['0x1901', proofInputs.domainSeparator, proofInputs.actionHash]));
    expect(ethers.recoverAddress(digest, signature)).toBe(a.address);
  });
});
