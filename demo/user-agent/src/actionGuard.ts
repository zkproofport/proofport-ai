import {isDeepStrictEqual} from 'node:util';
import type {Permission,PermissionKind} from '../../staking-service/src/permissions.ts';

/** Receipts come only from the local permission channel, never model arguments. */
function assertApproval(permission:Permission|undefined,kind:PermissionKind,details:Record<string,unknown>|undefined){
  if(!permission||permission.kind!==kind||permission.status!=='approved'||!permission.decidedAt)throw Error('The user must approve this action in the dApp first.');
  if(!details||!isDeepStrictEqual(permission.details,details))throw Error('Execution differs from the user-approved request. Submit a new instruction.');
  const action=details.action as {message?:{expiresAt?:unknown}}|undefined;
  const expiresAt=Number(action?.message?.expiresAt);
  if(!Number.isSafeInteger(expiresAt)||expiresAt<=Math.floor(Date.now()/1000))throw Error('The user-approved delegation has expired. Submit a new instruction.');
}

/** State gates constrain spending; they never select the model's next tool. */
export class ActionGuard {
  discovered=false; guideRead=false; mcpConnected=false; delegated=false; verified=false;
  #proofPermission:Permission|undefined;
  #stakePermission:Permission|undefined;
  private proofAttempted=false; private stakeAttempted=false;
  readonly amount:string;
  constructor(amount:string){this.amount=amount;}
  approveProof(permission:Permission,details:Record<string,unknown>){assertApproval(permission,'proof',details);this.#proofPermission=structuredClone(permission);}
  approveStake(permission:Permission,details:Record<string,unknown>){assertApproval(permission,'stake',details);this.#stakePermission=structuredClone(permission);}
  proof(details?:Record<string,unknown>){
    if(!this.discovered||!this.guideRead||!this.mcpConnected||!this.delegated)throw Error('Read the discovered prover guide, connect MCP, and prepare the delegation before buying a proof.');
    assertApproval(this.#proofPermission,'proof',details);
    if(this.proofAttempted)throw Error('A paid proof was already attempted; automatic duplicate purchases are disabled.');
    this.proofAttempted=true;
  }
  stake(amount:string,details?:Record<string,unknown>){
    if(amount!==this.amount)throw Error('The requested amount differs from the user-approved amount.');
    if(!this.verified)throw Error('Verify the actual proof on Arc before staking.');
    assertApproval(this.#stakePermission,'stake',details);
    if(this.stakeAttempted)throw Error('Staking was already attempted; do not submit duplicate transactions.');
    this.stakeAttempted=true;
  }
}
