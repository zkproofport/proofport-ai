import { beforeEach,describe,expect,it,vi } from 'vitest';
const fake=vi.hoisted(()=>({queryFilter:vi.fn(),ownerOf:vi.fn(),tokenURI:vi.fn(),filters:{Transfer:vi.fn(()=> 'filter')}}));
vi.mock('ethers',async()=>{const actual=await vi.importActual<typeof import('ethers')>('ethers');return {...actual,ethers:{...actual.ethers,Contract:vi.fn(function(){return fake;})}};});
import { discoverProver,discoverMarketplaceProver } from '../demo/shared/discovery.js';
const owner='0x1111111111111111111111111111111111111111';
const config={registry:'0x2222222222222222222222222222222222222222',owner,fromBlock:0,allowedOrigin:'https://stg-ai.zkproofport.app'};
const metadata={active:true,x402Support:true,circuits:['arc_eligibility'],name:'prover',services:[{name:'x402',endpoint:config.allowedOrigin+'/api/v1/prove'}]};
const provider={getNetwork:async()=>({chainId:5042002n}),getBlockNumber:async()=>10000} as never;
beforeEach(()=>{vi.clearAllMocks();fake.ownerOf.mockResolvedValue(owner);fake.tokenURI.mockResolvedValue('data:application/json;base64,'+Buffer.from(JSON.stringify(metadata)).toString('base64'));});
describe('discovering a prover from Arc registry events',()=>{
  it('reads the token URI after verifying current ownership and searches older chunks',async()=>{
    fake.queryFilter.mockResolvedValueOnce([{args:[null,owner,3n]}]).mockResolvedValueOnce([{args:[null,owner,2n]}]);
    fake.ownerOf.mockResolvedValueOnce('0x3333333333333333333333333333333333333333').mockResolvedValueOnce(owner);
    expect(await discoverProver(provider,config)).toMatchObject({agentId:'2',endpoint:metadata.services[0].endpoint});
    expect(fake.queryFilter.mock.calls.map(call=>call.slice(1))).toEqual([[2,10000],[0,1]]);
    expect(fake.tokenURI).toHaveBeenCalledTimes(1);
  });
  it('fails on RPC errors instead of claiming no registrations',async()=>{
    fake.queryFilter.mockRejectedValue(new Error('RPC unavailable'));
    await expect(discoverProver(provider,config)).rejects.toThrow('RPC unavailable');
  });
  it('refuses ambiguous entries and unknown chain',async()=>{
    fake.queryFilter.mockResolvedValueOnce([{args:[null,owner,2n]},{args:[null,owner,3n]}]).mockResolvedValueOnce([]);
    await expect(discoverProver(provider,config)).rejects.toThrow('2 matching');
    await expect(discoverProver({getNetwork:async()=>({chainId:1n})} as never,config)).rejects.toThrow('not Arc');
  });
});
describe('marketplace registration document with independent Arc identity checks',()=>{
 it('uses live published IDs and verifies current owner and compatible on-chain metadata',async()=>{
  const fetcher=async()=>new Response(JSON.stringify({registrations:[{agentId:42,agentRegistry:'eip155:5042002:'+config.registry}]}));
  expect(await discoverMarketplaceProver(provider,config,fetcher)).toMatchObject({agentId:'42',endpoint:metadata.services[0].endpoint});
  fake.ownerOf.mockResolvedValue('0x3333333333333333333333333333333333333333');
  await expect(discoverMarketplaceProver(provider,config,fetcher)).rejects.toThrow('0 matching');
 });
 it('rejects registration claims for another chain or registry',async()=>{
  const fetcher=async()=>new Response(JSON.stringify({registrations:[{agentId:42,agentRegistry:'eip155:1:'+config.registry}]}));
  await expect(discoverMarketplaceProver(provider,config,fetcher)).rejects.toThrow('No matching Arc');
 });
});
