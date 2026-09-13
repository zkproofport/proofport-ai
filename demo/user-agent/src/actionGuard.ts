/** State gates constrain spending; they never select the model's next tool. */
export class ActionGuard {
  discovered=false; guideRead=false; mcpConnected=false; delegated=false; verified=false;
  private proofAttempted=false; private stakeAttempted=false;
  readonly amount:string;
  constructor(amount:string){this.amount=amount;}
  proof(){
    if(!this.discovered||!this.guideRead||!this.mcpConnected||!this.delegated)throw Error('Read the discovered prover guide, connect MCP, and prepare the delegation before buying a proof.');
    if(this.proofAttempted)throw Error('A paid proof was already attempted; automatic duplicate purchases are disabled.');
    this.proofAttempted=true;
  }
  stake(amount:string){
    if(amount!==this.amount)throw Error('The requested amount differs from the user-approved amount.');
    if(!this.verified)throw Error('Verify the actual proof on Arc before staking.');
    if(this.stakeAttempted)throw Error('Staking was already attempted; do not submit duplicate transactions.');
    this.stakeAttempted=true;
  }
}
