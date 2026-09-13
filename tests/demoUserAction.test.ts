import {afterEach,describe,it,expect,vi} from 'vitest';
import {ethers} from 'ethers';
import {readUserStakeAction} from '../demo/shared/userAction.ts';
import * as actionPolicy from '../demo/shared/userAction.ts';
import {generateProof} from '../packages/sdk/src/flow.js';
import {fromPrivateKey} from '../packages/sdk/src/signer.js';

const gate='0x1111111111111111111111111111111111111111',wallet='0x2222222222222222222222222222222222222222';
function submitted(){return {
 domain:{name:'Ledger House Staking',version:'1',chainId:5042002,verifyingContract:gate},
 types:{CredentialDelegation:[{name:'delegate',type:'address'},{name:'action',type:'string'},{name:'amount',type:'uint256'},{name:'expiresAt',type:'uint256'},{name:'nonce',type:'string'}]},
 primaryType:'CredentialDelegation',message:{delegate:wallet,action:'stake',amount:'10000000',expiresAt:String(Math.floor(Date.now()/1000)+2700),nonce:'chosen-by-the-user'},
};}
afterEach(()=>vi.unstubAllGlobals());

describe('the user action reaches authorization unchanged',()=>{
 it('blocks a consumed action before another proof payment',async()=>{
  expect(typeof actionPolicy.assertUnusedStakeAction).toBe('function');
  const action=readUserStakeAction(submitted(),{gate,amount:'10',wallet});
  await expect(actionPolicy.assertUnusedStakeAction(action,{usedNonces:async()=>true,usedActions:async()=>false})).rejects.toThrow('already used');
  await expect(actionPolicy.assertUnusedStakeAction(action,{usedNonces:async()=>false,usedActions:async()=>true})).rejects.toThrow('already used');
  await expect(actionPolicy.assertUnusedStakeAction(action,{usedNonces:async()=>false,usedActions:async()=>false})).resolves.toBeUndefined();
 });
 it('the SDK accepts user-defined struct names, field names, types and nested values',async()=>{
  const action={
   domain:{name:'User chosen service',version:'7',chainId:5042002,verifyingContract:gate},
   primaryType:'MyCustomAction',
   types:{MyCustomAction:[{name:'actor',type:'address'},{name:'memo',type:'string'},{name:'enabled',type:'bool'},{name:'parameters',type:'MyParameters'}],
    MyParameters:[{name:'quantity',type:'uint256'},{name:'policy',type:'bytes32'}]},
   message:{actor:wallet,memo:'Entirely user-defined keys and values',enabled:true,parameters:{quantity:'42',policy:ethers.id('user-policy')}},
  };
  const signer=fromPrivateKey(ethers.Wallet.createRandom().privateKey);
  let signed:Record<string,unknown>|undefined;
  vi.stubGlobal('fetch',async()=>{throw Error('stop-at-attestation-boundary');});
  await expect(generateProof({baseUrl:'http://localhost:1'} as never,{attestation:signer},{circuit:'arc_eligibility',action},
   {onStep:step=>{if(step.name==='Sign Typed Action')signed=step.data as Record<string,unknown>;}}
  )).rejects.toThrow('stop-at-attestation-boundary');
  expect(signed?.primaryType).toBe('MyCustomAction');
  expect(signed?.actionHash).toBe(ethers.TypedDataEncoder.hashStruct(action.primaryType,action.types,action.message));
  expect(ethers.verifyTypedData(action.domain,action.types,action.message,String(signed?.signature))).toBe(await signer.getAddress());
 });
 it('preserves custom nonce and deadline representations and owns an immutable copy',()=>{
  const input=submitted(),action=readUserStakeAction(input,{gate,amount:'10',wallet});
  expect(action).toEqual(input);expect(action.message.nonce).toBe('chosen-by-the-user');
  expect(typeof action.message.expiresAt).toBe('string');
  input.message.nonce='changed-after-submit';expect(action.message.nonce).toBe('chosen-by-the-user');
 });
 it('refuses to authorize a different operational wallet',()=>{
  expect(()=>readUserStakeAction(submitted(),{gate,amount:'10',wallet:gate})).toThrow('Circle Agent Wallet B');
 });
 it('rejects missing nonce, extra unsigned fields and reordered contract fields',()=>{
  const input=submitted();
  for(const value of [
   {...input,message:{...input.message,nonce:''}},
   {...input,message:{...input.message,extraPermission:'withdraw all'}},
   {...input,types:{CredentialDelegation:[...input.types.CredentialDelegation].reverse()}},
  ])expect(()=>readUserStakeAction(value,{gate,amount:'10',wallet})).toThrow();
 });
 it('the SDK signs the exact submitted EIP-712 action and binds its hashes',async()=>{
  const input=submitted(),action=readUserStakeAction(input,{gate,amount:'10',wallet});
  const key=ethers.Wallet.createRandom().privateKey,signer=fromPrivateKey(key);
  let signed:Record<string,unknown>|undefined;
  // The test stops after a real local signature, before any proof purchase or external request.
  vi.stubGlobal('fetch',async()=>{throw Error('stop-at-attestation-boundary');});
  await expect(generateProof({baseUrl:'http://localhost:1'} as never,{attestation:signer},{circuit:'arc_eligibility',scope:'ledger-house',action},
   {onStep:step=>{if(step.name==='Sign Typed Action')signed=step.data as Record<string,unknown>;}}
  )).rejects.toThrow('stop-at-attestation-boundary');
  expect(signed?.domainSeparator).toBe(ethers.TypedDataEncoder.hashDomain(input.domain));
  expect(signed?.actionHash).toBe(ethers.TypedDataEncoder.hashStruct(input.primaryType,input.types,input.message));
  const signature=String(signed?.signature),address=new ethers.Wallet(key).address;
  expect(ethers.verifyTypedData(input.domain,input.types,input.message,signature)).toBe(address);
  for(const change of [{nonce:'other'},{amount:'10000001'},{delegate:gate},{expiresAt:'1'}])
   expect(ethers.verifyTypedData(input.domain,input.types,{...input.message,...change},signature)).not.toBe(address);
 });
});
