import {describe,it,expect,vi} from 'vitest';
import {signPayment,assertApprovedPayment,paymentOffers} from '../../packages/sdk/src/payment.ts';
const approved={network:'eip155:5042002',scheme:'exact',amount:'1000',asset:'0x3600000000000000000000000000000000000000',payTo:'0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c',extra:{name:'GatewayWalletBatched',version:'1',verifyingContract:'0x0077777d7EBA4688BDeF3E311b846F25870A19B9'}};
describe('actual payment signature matches the user-approved offer',()=>{
 it('accepts the same terms with a fresh nonce',()=>{expect(()=>assertApprovedPayment(paymentOffers({accepts:[{...approved,extra:{...approved.extra,nonce:'new'}}]})[0],approved)).not.toThrow();});
 it.each([{amount:'1000000'},{payTo:'0x'+'12'.repeat(20)},{asset:'0x'+'34'.repeat(20)},{network:'eip155:8453'},{scheme:'other'},{extra:{...approved.extra,name:'Other'}},{extra:{...approved.extra,verifyingContract:'0x'+'56'.repeat(20)}},{extra:{...approved.extra,version:'2'}}])('refuses changed offer before asking the wallet to sign %j',async change=>{
  const wallet={address:'0x'+'78'.repeat(20),signTypedData:vi.fn()} as any;
  await expect(signPayment({accepts:[{...approved,...change}]},wallet,{approvedPayment:approved,maxPayment:'0.001'})).rejects.toThrow('approved');
  expect(wallet.signTypedData).not.toHaveBeenCalled();
 });
});
