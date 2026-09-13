/** Ledger House: Arc contract receipts are the source of truth for positions. */
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ethers, STAKING_ABI, STAKE_TYPES } from '../../shared/flow.ts';
import { loadDemoConfig } from '../../shared/config.ts';
import { discoverProver } from '../../shared/discovery.ts';
import { stakeFromReceipt } from '../../shared/receipt.ts';
import { candidateMatchesProof, normalizeArcPublicInputs, extractArcPublicMetadata } from '../../audit/address-audit.ts';
import { installRecordingRoutes, isLocalRecordingRequest } from './recordingRoutes.ts';

const PORT=Number(process.env.PORT ?? 4100);
const config=loadDemoConfig();
const provider=new ethers.JsonRpcProvider(config.rpcUrl);
const gate=new ethers.Contract(config.gate,STAKING_ABI,provider);
const PROVER_URL=config.discovery.allowedOrigin;
const app=express();
app.use(express.json({limit:'4mb'}));
let latestProof:{circuitId:string;proof:string;publicInputs:string[]}|null=null;
let positionsCache:{at:number;rows:unknown[]}|null=null;
let discoveryCache:{at:number;value:Awaited<ReturnType<typeof discoverProver>>}|null=null;

async function positions(){
  if(positionsCache&&Date.now()-positionsCache.at<5000)return positionsCache.rows;
  const head=await provider.getBlockNumber();
  const events:ethers.EventLog[]=[];
  for(let start=config.deploymentBlock;start<=head;start+=9999){
    const chunk=await gate.queryFilter(gate.filters.Staked(),start,Math.min(head,start+9998));
    events.push(...chunk as ethers.EventLog[]);
  }
  const latestByWallet=new Map<string,ethers.EventLog>();
  for(const event of events)latestByWallet.set(ethers.getAddress(event.args.delegate),event);
  const rows=await Promise.all([...latestByWallet].map(async([wallet,event])=>({wallet,
    amount:ethers.formatUnits(await gate.balances(wallet),6),txHash:event.transactionHash,blockNumber:event.blockNumber})));
  positionsCache={at:Date.now(),rows};
  return rows;
}
async function marketplace(){
  if(discoveryCache&&Date.now()-discoveryCache.at<15000)return discoveryCache.value;
  const value=await discoverProver(provider,config.discovery);
  discoveryCache={at:Date.now(),value};
  return value;
}
app.get('/.well-known/service.json',(_req,res)=>res.json({
  name:'Ledger House',description:'Stake USDC on Arc with a Coinbase KYC delegation proof.',chain:config,
  requires:{proof:{circuit:'arc_eligibility',credential:'Coinbase KYC',discovery:config.discovery},
    delegation:{primaryType:'CredentialDelegation',domain:{name:'Ledger House Staking',version:'1',chainId:config.chainId,verifyingContract:config.gate},
      fields:STAKE_TYPES.CredentialDelegation}},
  endpoints:{stake:'POST /stake with the successful transaction hash',marketplace:'GET /marketplace/agents'},
}));
app.get('/marketplace/agents',async(_req,res)=>{
  try{res.json({chainId:config.chainId,registry:config.discovery.registry,agents:[await marketplace()]});}
  catch(error){res.status(503).json({error:(error as Error).message,agents:[]});}
});
app.post('/stake',async(req,res)=>{
  if(!req.body?.txHash)return res.status(402).json({error:'PROOF_REQUIRED',message:'Obtain a Coinbase KYC delegation proof, then call the Arc staking contract from the delegate wallet.',gate:config.gate,discovery:'/marketplace/agents'});
  if(typeof req.body.txHash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(req.body.txHash))return res.status(400).json({error:'BAD_TRANSACTION_HASH'});
  try{
    const receipt=await provider.getTransactionReceipt(req.body.txHash);
    if(!receipt)return res.status(409).json({error:'TRANSACTION_PENDING'});
    const staked=stakeFromReceipt(receipt,config.gate);
    positionsCache=null;
    res.json({ok:true,staked,verifiedOn:{chainId:config.chainId,gate:config.gate,verifier:config.verifier}});
  }catch(error){res.status(403).json({error:'STAKE_NOT_VERIFIED',message:(error as Error).message});}
});
app.post('/demo/proof',(req,res)=>{
  if(!isLocalRecordingRequest(req,PORT))return res.sendStatus(403);
  try{
    if(req.body.circuitId!=='arc_eligibility'||typeof req.body.proof!=='string'||!/^0x(?:[0-9a-fA-F]{2})+$/.test(req.body.proof))throw new Error('Expected an Arc eligibility proof.');
    latestProof={circuitId:'arc_eligibility',proof:req.body.proof,publicInputs:normalizeArcPublicInputs(req.body.publicInputs)};
    res.json({fingerprint:extractArcPublicMetadata(latestProof.publicInputs).publicInputsFingerprint});
  }catch(error){res.status(400).json({error:(error as Error).message});}
});
app.get('/demo/proof',(_req,res)=>{
  if(!latestProof)return res.status(404).json({error:'No proof recorded yet.'});
  res.set('Cache-Control','no-store').json(latestProof);
});
app.post('/demo/audit',async(req,res)=>{
  if(!isLocalRecordingRequest(req,PORT))return res.sendStatus(403);
  if(!latestProof)return res.status(409).json({error:'Generate a proof first.'});
  try{
    let candidate=req.body?.candidate;
    if(req.body?.fromEnvironment===true){
      candidate=process.env.E2E_ATTESTATION_WALLET_ADDRESS;
      if(!candidate&&process.env.ATTESTATION_KEY){
        try{candidate=new ethers.Wallet(process.env.ATTESTATION_KEY).address;}
        catch{throw new Error('Configured attestation key is invalid.');}
      }
    }
    const matches=candidateMatchesProof(latestProof.publicInputs,candidate);
    const verifier=new ethers.Contract(config.verifier,['function verify(bytes,bytes32[]) view returns(bool)'],provider);
    const proofVerified=Boolean(await verifier.verify(latestProof.proof,latestProof.publicInputs));
    res.json({matches,proofVerified,fingerprint:extractArcPublicMetadata(latestProof.publicInputs).publicInputsFingerprint,
      explanation:'This checks a supplied candidate against the public nullifier. A match demonstrates linkability, not recovery of an unknown address.'});
  }catch(error){res.status(400).json({error:(error as Error).message});}
});
installRecordingRoutes(app,{proverUrl:PROVER_URL,port:PORT,positions,chain:config});
app.use(express.static(fileURLToPath(new URL('../public/',import.meta.url))));
app.listen(PORT,'127.0.0.1',()=>console.log(`Ledger House: http://localhost:${PORT}\nArc staking gate: ${config.gate}\nGCP prover discovery: ${config.discovery.registry}`));
