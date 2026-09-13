import {isDeepStrictEqual} from 'node:util';
import {validateTypedAction} from '@zkproofport-app/sdk';
import {ethers,buildStakeDelegation,STAKE_TYPES} from './flow.ts';

export type StakeAction=Omit<ReturnType<typeof buildStakeDelegation>,'message'> & {
 message:{delegate:string;action:string;amount:string;expiresAt:number|string;nonce:string};
};

/** Read the deployed Gate before signing/paying, so an old UI draft cannot buy another proof. */
export async function assertUnusedStakeAction(action:StakeAction,gate:{usedNonces:(wallet:string,nonce:string)=>Promise<boolean>;usedActions:(hash:string)=>Promise<boolean>}){
 const hash=ethers.TypedDataEncoder.hashStruct(action.primaryType,action.types,action.message);
 const [nonceUsed,actionUsed]=await Promise.all([gate.usedNonces(action.message.delegate,ethers.id(action.message.nonce)),gate.usedActions(hash)]);
 if(nonceUsed||actionUsed)throw Error('This action or nonce was already used. Prepare a fresh user action before buying a proof.');
}

/** Validate the service policy without rebuilding or changing the user's signed object. */
export function readUserStakeAction(value:unknown,expected:{gate:string;amount:string;wallet?:string}):StakeAction {
 const error=validateTypedAction(value);if(error)throw Error(error);
 const action=value as StakeAction;
 const keys=(object:object,names:string[])=>isDeepStrictEqual(Object.keys(object).sort(),names.sort());
 if(!keys(action,['domain','types','primaryType','message'])
  ||!keys(action.domain,['name','version','chainId','verifyingContract'])
  ||!keys(action.message,['delegate','action','amount','expiresAt','nonce']))throw Error('The staking action contains missing or unsigned fields.');
 if(action.primaryType!=='CredentialDelegation'||!isDeepStrictEqual(action.types,STAKE_TYPES))throw Error('This vault requires its exact staking action schema.');
 const expiresAt=Number(action.message.expiresAt);
 if((typeof action.message.expiresAt!=='number'&&!(typeof action.message.expiresAt==='string'&&/^\d+$/.test(action.message.expiresAt)))
  ||!Number.isSafeInteger(expiresAt)||expiresAt<=Math.floor(Date.now()/1000))throw Error('The user action deadline must be a future Unix timestamp.');
 const reference=buildStakeDelegation({gate:expected.gate,delegate:action.message.delegate,amount:expected.amount,expiresAt,nonce:action.message.nonce});
 if(ethers.TypedDataEncoder.hashDomain(action.domain)!==ethers.TypedDataEncoder.hashDomain(reference.domain))throw Error('The user action must target this staking contract on Arc Testnet.');
 if(action.message.action!=='stake'||action.message.amount!==reference.message.amount)throw Error('The user action must match the requested USDC stake amount.');
 if(expected.wallet&&ethers.getAddress(action.message.delegate)!==ethers.getAddress(expected.wallet))throw Error('The user action must name the connected Circle Agent Wallet B.');
 return structuredClone(action);
}
