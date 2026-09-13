import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { buildStakeDelegation, readCircleTransactionHash, proverEndpointFromMetadata } from '../demo/shared/flow.js';

const gate = '0x1111111111111111111111111111111111111111';
const delegate = '0x2222222222222222222222222222222222222222';
describe('onchain recording boundaries', () => {
  it('binds the gate, wallet and six-decimal stake amount into the signed action', () => {
    const action = buildStakeDelegation({ gate, delegate, amount: '1.25', expiresAt: 2000000000, nonce: 'one' });
    expect(action.domain.verifyingContract).toBe(gate);
    expect(action.domain.chainId).toBe(5042002);
    expect(action.message.amount).toBe('1250000');
    const altered = { ...action.message, amount: '1250001' };
    expect(ethers.TypedDataEncoder.hash(action.domain, action.types, altered)).not.toBe(ethers.TypedDataEncoder.hash(action.domain, action.types, action.message));
  });
  it('accepts only real transaction hashes, not Circle challenge ids or batch UUIDs', () => {
    expect(readCircleTransactionHash({data:{txHash:'0x'+'ab'.repeat(32),state:'CONFIRMED'}})).toBe('0x'+'ab'.repeat(32));
    expect(() => readCircleTransactionHash({data:{id:'challenge-id',state:'PENDING'}})).toThrow();
    expect(() => readCircleTransactionHash({data:{txHash:'uuid-batch'}})).toThrow();
    expect(() => readCircleTransactionHash({data:{txHash:'0x'+'ab'.repeat(32),state:'FAILED'}})).toThrow();
  });
  it('requires active Arc proof metadata and the permitted GCP origin', () => {
    const metadata = {active:true,circuits:['arc_eligibility'],x402Support:true,services:[{name:'x402',endpoint:'https://stg-ai.zkproofport.app/api/v1/prove'}]};
    expect(proverEndpointFromMetadata(metadata, 'https://stg-ai.zkproofport.app')).toBe(metadata.services[0].endpoint);
    for (const bad of [{...metadata,active:false},{...metadata,circuits:['coinbase_attestation']},{...metadata,services:[{name:'x402',endpoint:'http://localhost:4002/api/v1/prove'}]},{...metadata,services:[]}]) {
      expect(() => proverEndpointFromMetadata(bad,'https://stg-ai.zkproofport.app')).toThrow();
    }
  });
});
