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

import { parseUnits } from 'ethers';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildPaymentRequirements, getPaymentNetwork } from '../../src/payment/networks.js';

const payer = privateKeyToAccount(`0x${'01'.padStart(64, '0')}`);
function fixture(network: string) {
 const [raw] = buildPaymentRequirements({ networks: [getPaymentNetwork(network)], price: '0.001', payTo: approved.payTo,
  resource: 'https://example.invalid/prove', nonce: `0x${'12'.repeat(32)}`, parseUnits });
 const offer = paymentOffers({ accepts: [raw] })[0];
 const extra = raw.extra as Record<string, string>;
 return { raw, pin: { network: offer.network, scheme: raw.scheme, amount: offer.amount, asset: offer.asset, payTo: offer.payTo,
  extra: { name: extra.name, version: extra.version, verifyingContract: extra.verifyingContract || offer.asset } } };
}

describe('approval pins the contract actually used by the selected payment protocol', () => {
 it.each(['base', 'base-sepolia', 'ethereum', 'ethereum-sepolia', 'arc-testnet', 'arc-testnet-nano'])(
  'signs the approved %s domain with real x402/Circle encoding', async network => {
   const { raw, pin } = fixture(network);
   const sign = vi.fn(async (message: any) => {
    expect(message.domain.verifyingContract.toLowerCase()).toBe(pin.extra.verifyingContract.toLowerCase());
    expect(message.domain.name).toBe(pin.extra.name);
    expect(message.domain.version).toBe(pin.extra.version);
    const signature = await payer.signTypedData(message);
    expect(await recoverTypedDataAddress({ ...message, signature })).toBe(payer.address);
    return signature;
   });
   const result = await signPayment({ accepts: [raw] }, { address: payer.address, signTypedData: sign, describe: () => 'test' }, { approvedPayment: pin });
   expect(sign).toHaveBeenCalledOnce();
   expect(result.payer).toBe(payer.address);
  });

 it.each([
  { amount: '99999' }, { payTo: `0x${'34'.repeat(20)}` }, { asset: `0x${'56'.repeat(20)}` },
  { network: 'eip155:84532' }, { scheme: 'other' },
  { extra: { name: 'Other', version: '2' } }, { extra: { name: 'USDC', version: '3' } },
  { extra: { name: 'USDC', version: '2', verifyingContract: `0x${'78'.repeat(20)}` } },
 ])('rejects changed direct terms before signing: %j', async change => {
  const { raw, pin } = fixture('arc-testnet'); const sign = vi.fn();
  await expect(signPayment({ accepts: [{ ...raw, ...change }] }, { address: payer.address, signTypedData: sign, describe: () => 'test' }, { approvedPayment: pin })).rejects.toThrow(/approved/);
  expect(sign).not.toHaveBeenCalled();
 });

 it.each([
  { name: 'USDC' }, { version: '2' }, { name: '', version: '' },
  { name: 'USDC', version: '2', assetTransferMethod: 'permit2' },
  { name: 'USDC', version: '2', assetTransferMethod: 'unknown' },
  { name: 'GatewayWalletBatched', version: '1' },
  { name: 'GatewayWalletBatched', version: '1', verifyingContract: 'not-an-address' },
 ])('rejects unresolved or unsupported signing domains: %j', async extra => {
  const { raw, pin } = fixture('arc-testnet'); const sign = vi.fn();
  const sameClaim = { ...pin, extra: { ...extra, verifyingContract: (extra as any).verifyingContract || pin.asset } } as any;
  await expect(signPayment({ accepts: [{ ...raw, extra }] }, { address: payer.address, signTypedData: sign, describe: () => 'test' }, { approvedPayment: sameClaim })).rejects.toThrow(/approved/);
  expect(sign).not.toHaveBeenCalled();
 });
});
