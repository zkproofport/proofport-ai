import {describe,it,expect,vi} from 'vitest';
import {readCoinbaseKyc,gatewayDebit,readOnlyObservation} from '../demo/shared/walletStatus.ts';
const wallet='0x'+'11'.repeat(20);
describe('observed wallet and Gateway evidence',()=>{
 it('reports missing direct KYC only after a successful empty EAS response',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{attestations:[]}})));
  expect((await readCoinbaseKyc(wallet,fetcher)).status).toBe('not_found');
  const body=JSON.parse(fetcher.mock.calls[0][1].body);expect(body.variables.recipient).toBe(wallet);expect(body.query).toContain('revoked');
 });
 it.each([new Response('{}',{status:503}),new Response('{"errors":[{"message":"unavailable"}]}'),new Response('{"data":{}}')])('never calls an unavailable KYC lookup not found',async response=>{
  expect((await readCoinbaseKyc(wallet,async()=>response)).status).toBe('unknown');
 });
 it('distinguishes a current attestation from an expired one',async()=>{
  const response=(expirationTime:number)=>new Response(JSON.stringify({data:{attestations:[{attester:'0x357458739F90461b99789350868CD7CF330Dd7EE',expirationTime}]}}));
  expect((await readCoinbaseKyc(wallet,async()=>response(0))).status).toBe('found');
  expect((await readCoinbaseKyc(wallet,async()=>response(1))).status).toBe('not_found');
 });
 it('retries only read-only enrichment and preserves success when observations are unavailable',async()=>{
  let attempts=0;expect(await readOnlyObservation(async()=>{if(++attempts===1)throw Error('temporary');return 'receipt balance';})).toBe('receipt balance');
  expect(await readOnlyObservation(async()=>{throw Error('unavailable');})).toBeUndefined();
 });
 it('confirms only the exact observed 0.001 USDC Gateway debit',()=>{
  expect(gatewayDebit('2.984','2.984')).toBe(false);
  expect(gatewayDebit('2.984','2.983')).toBe(true);
  expect(()=>gatewayDebit('2.984','2.982')).toThrow();
  expect(()=>gatewayDebit('2.984','2.985')).toThrow();
 });
});
