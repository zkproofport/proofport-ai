import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ethers,STAKING_ABI} from './flow.ts';
import {publishedSdk} from './proverPackages.ts';
import {selectAgentDelegate} from '../user-agent/src/wallet.ts';
import type {DemoConfig} from './config.ts';

const EAS_URL='https://base.easscan.org/graphql';
const KYC_SCHEMA='0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9';
const ATTESTER='0x357458739f90461b99789350868cd7cf330dd7ee';
export async function readCoinbaseKyc(wallet:string,fetcher:typeof fetch=fetch){
 const checkedAt=new Date().toISOString();
 try{
  const response=await fetcher(EAS_URL,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),body:JSON.stringify({
   query:'query($schema:String!,$recipient:String!){attestations(where:{schemaId:{equals:$schema},recipient:{equals:$recipient},revoked:{equals:false}},orderBy:[{time:desc}],take:1){id attester expirationTime}}',
   variables:{schema:KYC_SCHEMA,recipient:ethers.getAddress(wallet).toLowerCase()},
  })});
  const data=await response.json() as {errors?:unknown;data?:{attestations?:{attester:string;expirationTime:number}[]}};
  if(!response.ok||data.errors||!Array.isArray(data.data?.attestations))throw Error('KYC lookup unavailable');
  if(data.data.attestations.some(a=>typeof a.attester!=='string'||a.attester.toLowerCase()!==ATTESTER||!Number.isSafeInteger(a.expirationTime)))throw Error('Unverified attestation issuer');
  const found=data.data.attestations.some(a=>a.expirationTime===0||a.expirationTime>Date.now()/1000);
  return {status:found?'found' as const:'not_found' as const,source:'Base EAS',checkedAt};
 }catch{return {status:'unknown' as const,source:'Base EAS',checkedAt};}
}
export async function readOperationalWallet(provider:ethers.JsonRpcProvider,config:DemoConfig){
 const {listArcAgentWallets}=await publishedSdk();
 const wallet=selectAgentDelegate(await listArcAgentWallets('ARC-TESTNET'),process.env.ARC_AGENT_WALLET);
 const usdc=new ethers.Contract(config.usdc,['function balanceOf(address) view returns(uint256)'],provider);
 const gate=new ethers.Contract(config.gate,STAKING_ABI,provider);
 const [directKyc,balance,position]=await Promise.all([readCoinbaseKyc(wallet),usdc.balanceOf(wallet),gate.balances(wallet)]);
 return {wallet,walletType:'Circle Agent Wallet',directKyc,walletUSDC:ethers.formatUnits(balance,6),positionUSDC:ethers.formatUnits(position,6),chainId:config.chainId};
}
export async function readGatewayBalance(wallet:string){
 let stdout:string;
 try{({stdout}=await promisify(execFile)('circle',['gateway','balance','--address',wallet,'--chain','ARC-TESTNET','--output','json'],{env:{...process.env,CIRCLE_ACCEPT_TERMS:'1'},timeout:15000,maxBuffer:1024*1024}));}
 catch{throw Error('Circle Gateway balance lookup failed.');}
 const data=JSON.parse(stdout).data;
 if(data?.token!=='USDC'||ethers.getAddress(data.address)!==ethers.getAddress(wallet)||typeof data.total!=='string')throw Error('Unexpected Circle Gateway balance response.');
 ethers.parseUnits(data.total,6);
 return data.total as string;
}
export function gatewayDebit(before:string,after:string){
 const debit=ethers.parseUnits(before,6)-ethers.parseUnits(after,6);
 if(debit===0n)return false;
 if(debit!==1000n)throw Error('Gateway balance change does not equal the approved proof fee.');
 return true;
}
/** Retry read-only evidence, never a payment, proof purchase or transaction. */
export async function readOnlyObservation<T>(read:()=>Promise<T>):Promise<T|undefined>{
 for(let attempt=0;attempt<2;attempt++){try{return await read();}catch{/* Optional enrichment cannot invalidate a successful proof or receipt. */}}
 return undefined;
}
