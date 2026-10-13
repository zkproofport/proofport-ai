import {describe,it,expect,vi} from 'vitest';
import {signPayment} from '../../packages/sdk/src/payment.ts';
import {walletFromPrivateKey} from '../../packages/sdk/src/wallets.ts';

const sepoliaOffer={network:'eip155:11155111',networkName:'ethereum-sepolia',scheme:'exact',amount:'1000',asset:'0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',payTo:'0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c',maxTimeoutSeconds:300,extra:{name:'USDC',version:'2'}};
const baseOffer={...sepoliaOffer,network:'eip155:8453',networkName:'base',asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',extra:{name:'USD Coin',version:'2'}};

describe('SDK USDC spending limits without an exact approval object',()=>{
 it.each([sepoliaOffer,baseOffer])('rejects an over-limit $network offer before signing',async offer=>{
  const wallet=await walletFromPrivateKey('0x'+'11'.repeat(32));const sign=vi.spyOn(wallet,'signTypedData');
  await expect(signPayment({accepts:[{...offer,amount:'1001'}]},wallet,{maxPayment:'0.001'})).rejects.toThrow(/maximum.*USDC/i);
  expect(sign).not.toHaveBeenCalled();
 });
 it('applies the default one-USDC cap to Ethereum Sepolia',async()=>{
  const wallet=await walletFromPrivateKey('0x'+'11'.repeat(32));const sign=vi.spyOn(wallet,'signTypedData');
  await expect(signPayment({accepts:[{...sepoliaOffer,amount:'1000001'}]},wallet)).rejects.toThrow(/maximum.*USDC/i);
  expect(sign).not.toHaveBeenCalled();
 });
 it.each(['0.001','$0.001'])('signs exactly the selected Ethereum Sepolia fee at cap %s',async maxPayment=>{
  const wallet=await walletFromPrivateKey('0x'+'11'.repeat(32));
  const result=await signPayment({accepts:[{...baseOffer,amount:'9000000'},sepoliaOffer]},wallet,{network:'ethereum-sepolia',maxPayment});
  const decoded=JSON.parse(Buffer.from(result.headers['PAYMENT-SIGNATURE'],'base64').toString());
  expect(decoded.payload.authorization.value).toBe('1000');expect(result.paidOn).toBe('ethereum-sepolia');
 });
 it.each(['-1','NaN','1e3','0.0000001'])('rejects invalid USDC cap %s without signing',async maxPayment=>{
  const wallet=await walletFromPrivateKey('0x'+'11'.repeat(32));const sign=vi.spyOn(wallet,'signTypedData');
  await expect(signPayment({accepts:[sepoliaOffer]},wallet,{maxPayment})).rejects.toThrow(/maximum.*USDC/i);
  expect(sign).not.toHaveBeenCalled();
 });
});
