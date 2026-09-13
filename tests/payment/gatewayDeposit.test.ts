import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
const gateway={getBalance:vi.fn(),deposit:vi.fn()};
// Resolve the SDK's dependency instance even when npm installs it nested.
const sdkRequire=createRequire(new URL('../../packages/sdk/package.json',import.meta.url));
vi.doMock(sdkRequire.resolve('@circle-fin/x402-batching/client').replace(/\.js$/,'.mjs'),()=>({GatewayClient:vi.fn(function(){return gateway;})}));
const {ensureGatewayBalance}=await import('../../packages/sdk/src/nanopayment.ts');
const wallet={privateKey:('0x'+'11'.repeat(32)) as `0x${string}`,rpcUrl:'https://example.invalid'};
beforeEach(()=>{vi.resetAllMocks();gateway.getBalance.mockResolvedValue({available:5000000n,withdrawing:0n});gateway.deposit.mockResolvedValue({depositTxHash:'0xdeposit'});});
describe('Gateway deposit threshold semantics',()=>{
 it('deposits the requested amount when no threshold is supplied',async()=>{
  gateway.getBalance.mockResolvedValueOnce({available:5000000n,withdrawing:0n}).mockResolvedValueOnce({available:7000000n,withdrawing:0n});
  const result=await ensureGatewayBalance(wallet,undefined,'2');
  expect(result).toEqual({deposited:true,balance:{available:7000000n,withdrawing:0n},depositTxHash:'0xdeposit'});
  expect(gateway.deposit).toHaveBeenCalledExactlyOnceWith('2');
 });
 it('keeps an explicitly satisfied threshold read-only',async()=>{
  expect((await ensureGatewayBalance(wallet,5000000n,'2')).deposited).toBe(false);
  expect((await ensureGatewayBalance(wallet,0n,'2')).deposited).toBe(false);expect(gateway.deposit).not.toHaveBeenCalled();
 });
 it('deposits when the requested balance threshold is unmet',async()=>{
  expect((await ensureGatewayBalance(wallet,6000000n,'2')).deposited).toBe(true);expect(gateway.deposit).toHaveBeenCalledExactlyOnceWith('2');
 });
});
