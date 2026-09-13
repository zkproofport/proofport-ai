import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { delegationMatchesProof, delegateOf } from '../packages/sdk/src/delegation.js';
import { buildStakeDelegation, STAKE_TYPES } from '../demo/shared/flow.js';
import { loadDemoConfig } from '../demo/shared/config.js';
import { selectAgentDelegate } from '../demo/user-agent/src/wallet.js';

const GATE = '0xD0F3eE648386B59B484157332E736388Fcc41F47';
const VERIFIER = '0xCbC8E63fF92659E8B44cFF117D33005Bb669a018';
const DELEGATE = '0x000000000000000000000000000000000000000b';
const OTHER = '0x1111111111111111111111111111111111111111';
const NOW = 1000;
const EXPIRY = 2000;
function action(overrides: Partial<Parameters<typeof buildStakeDelegation>[0]> = {}) {
  return buildStakeDelegation({ gate: GATE, delegate: DELEGATE, amount: '1', expiresAt: EXPIRY, nonce: 'one', ...overrides });
}
// Independent ethers vector also exercised against the Solidity contract tests.
const proofInputs = {
  domainSeparator: '0x690922273390b31889bd58831eb6d10a9e88459f1208286785e4d0f38287aa27',
  actionHash: '0x276dd86c99bafbdc05dac35ea0d9239d061e15f85213717646ebf0eae5d123ca',
};

describe('the real staking demo holds together', () => {
  it('builds the amount-bound delegation accepted by the SDK and contract vector', () => {
    const built = action();
    expect(built.message.amount).toBe('1000000');
    expect(ethers.TypedDataEncoder.hashStruct('CredentialDelegation', STAKE_TYPES, built.message)).toBe(proofInputs.actionHash);
    expect(ethers.TypedDataEncoder.hashDomain(built.domain)).toBe(proofInputs.domainSeparator);
    expect(delegationMatchesProof({ action: built, ...proofInputs, now: NOW })).toBeNull();
    expect(ethers.getAddress(delegateOf(built))).toBe(ethers.getAddress(DELEGATE));
  });
  it.each([
    ['another connected wallet', { delegate: OTHER }],
    ['one extra USDC base unit', { amount: '1.000001' }],
    ['another nonce', { nonce: 'two' }],
    ['a later deadline', { expiresAt: EXPIRY + 1 }],
  ])('rejects the original proof with %s', (_label, change) => {
    expect(delegationMatchesProof({ action: action(change), ...proofInputs, now: NOW })).toMatch(/different delegation/);
  });
  it('rejects a different gate, including the proof verifier address', () => {
    for (const gate of [OTHER, VERIFIER]) {
      expect(delegationMatchesProof({ action: action({ gate }), ...proofInputs, now: NOW })).toMatch(/different service/);
    }
  });
  it('rejects a mainnet domain with unchanged action fields', () => {
    const built = action();
    built.domain.chainId = 1;
    expect(delegationMatchesProof({ action: built, ...proofInputs, now: NOW })).toMatch(/different service/);
  });
  it.each([EXPIRY, EXPIRY + 1])('rejects the genuine delegation at or after expiry (%s)', now => {
    expect(delegationMatchesProof({ action: action(), ...proofInputs, now })).toMatch(/expired/);
  });
  it('accepts the genuine delegation one second before expiry', () => {
    expect(delegationMatchesProof({ action: action(), ...proofInputs, now: EXPIRY - 1 })).toBeNull();
  });
  it.each(['0', '-1', '1.0000001', '1000001', '', ' ', '1e6'])('rejects invalid amount %j before signing', amount => {
    expect(() => action({ amount })).toThrow();
  });
  it('selects an existing Circle wallet and rejects replacement or ambiguous choices', () => {
    const connected = ethers.getAddress(DELEGATE);
    expect(selectAgentDelegate([connected])).toBe(connected);
    expect(selectAgentDelegate([connected, OTHER], connected)).toBe(connected);
    expect(() => selectAgentDelegate([], connected)).toThrow(/not in the connected/);
    expect(() => selectAgentDelegate([connected], OTHER)).toThrow(/not in the connected/);
    expect(() => selectAgentDelegate([connected, OTHER])).toThrow(/Exactly one connected wallet/);
  });
  it('loads the actual Arc deployment and pinned GCP registry configuration', () => {
    const config = loadDemoConfig();
    expect(config.chainId).toBe(5042002);
    expect(ethers.getAddress(config.gate)).toBe(GATE);
    expect(ethers.getAddress(config.verifier)).toBe(VERIFIER);
    expect(config.usdc).toBe('0x3600000000000000000000000000000000000000');
    expect(config.deploymentTx).toBe('0x92f07f307b0b597b4786ca2f9c816297ad3db63694874842a213709f88ae4ba7');
    expect(config.deploymentBlock).toBe(61837155);
    expect(new URL(config.rpcUrl).origin).toBe('https://rpc.testnet.arc.io');
    expect(ethers.getAddress(config.discovery.registry)).toBe('0x8004A818BFB912233c491871b3d84c89A494BD9e');
    expect(ethers.getAddress(config.discovery.owner)).toBe('0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c');
    expect(config.discovery.fromBlock).toBe(61836881);
    expect(new URL(config.discovery.allowedOrigin).origin).toBe('https://stg-ai.zkproofport.app');
  });
});
