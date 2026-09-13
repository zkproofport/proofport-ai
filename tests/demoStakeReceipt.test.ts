import { describe, expect, it } from 'vitest';
import { ethers, STAKING_ABI } from '../demo/shared/flow.js';
import { stakeFromReceipt } from '../demo/shared/receipt.js';
const gate='0x1111111111111111111111111111111111111111',wallet='0x2222222222222222222222222222222222222222';
const iface=new ethers.Interface(STAKING_ABI);
const encoded=iface.encodeEventLog(iface.getEvent('Staked')!,[wallet,1000000n,'0x'+'ab'.repeat(32)]);
const receipt={status:1,hash:'0x'+'cd'.repeat(32),blockNumber:123,logs:[{address:gate,...encoded}]};
describe('staking receipt acceptance',()=>{
  it('reads the real gate event amount and delegate',()=>{expect(stakeFromReceipt(receipt,gate)).toMatchObject({wallet,amount:'1.0',txHash:receipt.hash,blockNumber:123});});
  it('rejects reverted, unrelated and ambiguous receipts',()=>{
    expect(()=>stakeFromReceipt({...receipt,status:0},gate)).toThrow();
    expect(()=>stakeFromReceipt({...receipt,logs:[]},gate)).toThrow();
    expect(()=>stakeFromReceipt({...receipt,logs:[{address:wallet,...encoded}]},gate)).toThrow();
    expect(()=>stakeFromReceipt({...receipt,logs:[...receipt.logs,...receipt.logs]},gate)).toThrow();
  });
});
