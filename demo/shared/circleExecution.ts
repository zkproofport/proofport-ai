import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { readCircleTransactionHash } from './flow.ts';

const exec = promisify(execFile);
export async function executeFromAgentWallet(params: {wallet:string;contract:string;signature:string;args:string[];provider:ethers.JsonRpcProvider;rpcUrl:string}) {
  let stdout:string;
  try {
    ({stdout}=await exec('circle',['wallet','execute',params.signature,...params.args,'--contract',params.contract,'--address',params.wallet,
      '--chain','ARC-TESTNET','--rpc-url',params.rpcUrl,'--idempotency-key',randomUUID(),'--output','json'],
      {env:{...process.env,CIRCLE_ACCEPT_TERMS:'1'},maxBuffer:4*1024*1024,timeout:180000}));
  } catch(error) {
    // execFile errors contain the entire argv (including proof); only the CLI's error reason is useful.
    let reason='Circle contract execution failed. Check the wallet balance and policy.';
    try {const data=JSON.parse((error as {stdout?:string}).stdout ?? ''); if(typeof data.error?.message==='string') reason=data.error.message;} catch {}
    throw new Error(reason);
  }
  const hash=readCircleTransactionHash(JSON.parse(stdout));
  const receipt=await params.provider.waitForTransaction(hash,1,120000);
  if(!receipt || receipt.status!==1) throw new Error(`Arc transaction failed: ${hash}`);
  return receipt;
}
