import { Wallet } from 'ethers';
/** Redact before any tool result reaches either the language model or the UI. */
export function createRedactor(env: Record<string,string|undefined>) {
  const values=Object.entries(env).filter(([k,v])=>/(KEY|SECRET|TOKEN|PASSWORD|ATTESTATION_WALLET_ADDRESS)/i.test(k)&&v&&v.length>=8).map(([,v])=>v!);
  if(env.ATTESTATION_KEY){try{values.push(new Wallet(env.ATTESTATION_KEY).address);}catch{}}
  // Tool results are JSON strings: quotes, backslashes and control characters are escaped before redaction.
  const patterns=[...new Set(values.flatMap(value=>[value,JSON.stringify(value).slice(1,-1)]))]
    .sort((a,b)=>b.length-a.length)
    .map(value=>new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'));
  return (text:string)=>{
    let result=text;
    for(const pattern of patterns) result=result.replace(pattern,'****');
    return result;
  };
}
