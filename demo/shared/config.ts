import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import type { DiscoveryConfig } from './discovery.ts';
import { ARC_CHAIN_ID } from './flow.ts';
export interface DemoConfig {chainId:number;rpcUrl:string;usdc:string;gate:string;verifier:string;deploymentTx:string;deploymentBlock:number;discovery:DiscoveryConfig}
export function loadDemoConfig():DemoConfig {
  const config=JSON.parse(readFileSync(new URL('../arc-testnet.json',import.meta.url),'utf8')) as DemoConfig;
  if(config.chainId!==ARC_CHAIN_ID)throw new Error('Recording config must name Arc Testnet 5042002.');
  for(const key of ['usdc','gate','verifier'] as const)ethers.getAddress(config[key]);
  if(!Number.isSafeInteger(config.deploymentBlock)||config.deploymentBlock<0)throw new Error('Missing deployment block.');
  if(new URL(config.rpcUrl).protocol!=='https:')throw new Error('The Arc RPC must use HTTPS.');
  if(!config.discovery)throw new Error('Missing Arc registry discovery configuration.');
  return config;
}
