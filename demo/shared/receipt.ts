import { ethers, STAKING_ABI } from './flow.ts';
const iface=new ethers.Interface(STAKING_ABI);
export function stakeFromReceipt(receipt:{status:number|null;hash:string;blockNumber:number;logs:readonly {address:string;topics:readonly string[];data:string}[]},gate:string){
  if(receipt.status!==1)throw new Error('The transaction did not succeed.');
  const events=receipt.logs.filter(log=>log.address.toLowerCase()===gate.toLowerCase()).map(log=>{try{return iface.parseLog(log);}catch{return null;}}).filter(log=>log?.name==='Staked');
  if(events.length!==1)throw new Error('The receipt must contain exactly one Staked event from this gate.');
  const event=events[0]!;
  if(event.args.amount<=0n)throw new Error('Invalid on-chain stake amount.');
  return {wallet:ethers.getAddress(event.args.delegate),amount:ethers.formatUnits(event.args.amount,6),
    actionHash:String(event.args.actionHash),txHash:receipt.hash,blockNumber:receipt.blockNumber};
}
