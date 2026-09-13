import { ethers } from 'ethers';
import { ARC_CHAIN_ID, proverEndpointFromMetadata } from './flow.ts';

export interface DiscoveryConfig { registry:string;owner:string;fromBlock:number;allowedOrigin:string }
const ABI = ['function ownerOf(uint256) view returns(address)','function tokenURI(uint256) view returns(string)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)'];

/** Search real registry events, then validate current ownership and metadata. */
export async function discoverProver(provider: ethers.JsonRpcProvider, config: DiscoveryConfig) {
  if (Number((await provider.getNetwork()).chainId) !== ARC_CHAIN_ID) throw new Error('Discovery RPC is not Arc Testnet.');
  const head = await provider.getBlockNumber();
  if (!Number.isSafeInteger(config.fromBlock) || config.fromBlock < 0 || config.fromBlock > head || head-config.fromBlock > 2_000_000) throw new Error('Invalid or outdated registry search start block.');
  const owner = ethers.getAddress(config.owner);
  const registry = new ethers.Contract(config.registry, ABI, provider);
  const ids = new Set<string>();
  for (let end=head; end>=config.fromBlock; end-=9999) {
    const start=Math.max(config.fromBlock,end-9998);
    const logs=await registry.queryFilter(registry.filters.Transfer(null,owner),start,end);
    for(const log of logs.reverse()) ids.add((log as ethers.EventLog).args[2].toString());
  }
  const candidates: {agentId:string;registry:string;owner:string;endpoint:string;name:string}[]=[];
  for(const id of ids) {
    if(ethers.getAddress(await registry.ownerOf(id)) !== owner) continue;
    const uri=String(await registry.tokenURI(id));
    if (!uri.startsWith('data:application/json;base64,') || uri.length>150000) continue;
    try {
      const metadata=JSON.parse(Buffer.from(uri.slice('data:application/json;base64,'.length),'base64').toString('utf8'));
      const endpoint=proverEndpointFromMetadata(metadata,config.allowedOrigin);
      candidates.push({agentId:id,registry:config.registry,owner,endpoint,name:String(metadata.name ?? 'Registered prover')});
    } catch { /* Invalid or incompatible registration is not selected. */ }
  }
  if(candidates.length!==1) throw new Error(`Registry discovery found ${candidates.length} matching provers; expected one active GCP prover.`);
  return candidates[0];
}
