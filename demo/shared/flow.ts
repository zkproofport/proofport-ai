import { ethers } from 'ethers';
import { parseStakeAmount } from '../staking-service/src/recording.ts';
export { ethers };

export const ARC_CHAIN_ID = 5042002;
export const STAKING_ABI = [
  'function stakePacked(uint256 amount,bytes proof,bytes publicInputs,uint256 expiresAt,string nonce)',
  'function balances(address) view returns (uint256)',
  'function withdraw(uint256 amount)',
  'function domainSeparator() view returns (bytes32)',
  'function trustedSignerRoot() view returns (bytes32)',
  'function verifier() view returns (address)',
  'event Staked(address indexed delegate,uint256 amount,bytes32 indexed actionHash)',
  'event Withdrawn(address indexed delegate,uint256 amount)',
];
export const STAKE_TYPES = { CredentialDelegation: [
  {name:'delegate',type:'address'}, {name:'action',type:'string'}, {name:'amount',type:'uint256'},
  {name:'expiresAt',type:'uint256'}, {name:'nonce',type:'string'},
] };
export function buildStakeDelegation(input: {gate:string;delegate:string;amount:string;expiresAt:number;nonce:string}) {
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) throw new Error('Invalid delegation expiry.');
  if (!input.nonce || Buffer.byteLength(input.nonce) > 128) throw new Error('Invalid delegation nonce.');
  return { domain: {name:'Ledger House Staking',version:'1',chainId:ARC_CHAIN_ID,verifyingContract:ethers.getAddress(input.gate)},
    types: STAKE_TYPES, primaryType:'CredentialDelegation', message: {
      delegate:ethers.getAddress(input.delegate),action:'stake',amount:ethers.parseUnits(parseStakeAmount(input.amount),6).toString(),
      expiresAt:input.expiresAt,nonce:input.nonce,
    } };
}
export function readCircleTransactionHash(answer: unknown): string {
  const data = (answer as {data?:{txHash?:unknown;state?:string}})?.data;
  if (data?.state && ['FAILED','CANCELLED','DENIED'].includes(data.state)) throw new Error(`Circle transaction ${data.state}.`);
  if (typeof data?.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(data.txHash)) throw new Error('Circle has not returned an on-chain transaction hash.');
  return data.txHash;
}
export function proverEndpointFromMetadata(value: unknown, allowedOrigin: string): string {
  const m = value as {active?:boolean;circuits?:unknown;x402Support?:boolean;services?:{name:string;endpoint:string}[]};
  if (!m || m.active !== true || m.x402Support !== true || !Array.isArray(m.circuits) || !m.circuits.includes('arc_eligibility')) throw new Error('Registry entry is not an active Arc eligibility prover.');
  const endpoint = m.services?.find(s => s.name === 'x402')?.endpoint;
  if (!endpoint) throw new Error('Registered prover has no x402 endpoint.');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.origin !== new URL(allowedOrigin).origin || url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1/prove') throw new Error('Registered endpoint is outside the permitted GCP prover origin.');
  return url.href;
}
