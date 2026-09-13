/** Actual capabilities exposed to Claude Code. The model chooses tool calls. */
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {z} from 'zod';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import dotenv from 'dotenv';
import type {ApprovedPayment} from '@zkproofport-ai/sdk';
import {installPublishedProver} from '../../shared/installProver.ts';
import {publishedSdk,publishedProverPackages} from '../../shared/proverPackages.ts';
import {ethers,buildStakeDelegation,STAKING_ABI,ARC_CHAIN_ID} from '../../shared/flow.ts';
import {selectAgentDelegate} from './wallet.ts';
import {discoverMarketplaceProver} from '../../shared/discovery.ts';
import {loadDemoConfig} from '../../shared/config.ts';
import {executeFromAgentWallet} from '../../shared/circleExecution.ts';
import {normalizeArcPublicInputs,extractArcPublicMetadata} from '../../audit/address-audit.ts';
import {parseStakeAmount} from '../../staking-service/src/recording.ts';
import {ActionGuard} from './actionGuard.ts';
import type {Permission} from '../../staking-service/src/permissions.ts';
import {createRedactor} from './privacy.ts';
import {validateNanoOffer,validateProofBinding} from './policy.ts';
import {readCoinbaseKyc,readGatewayBalance,gatewayDebit,readOnlyObservation} from '../../shared/walletStatus.ts';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const env={...dotenv.parse(readFileSync(resolve(root,'.env.development'))),...dotenv.parse(readFileSync(resolve(root,'.env.test'))),...process.env};
for(const key of ['CDP_API_KEY_ID','CDP_API_KEY_SECRET','CDP_WALLET_SECRET','ARC_WALLET_DEBUG'])delete env[key];
Object.assign(process.env,env,{CIRCLE_ACCEPT_TERMS:'1'});
const redact=createRedactor(env);
const service=new URL(process.env.DEMO_SERVICE!);
if(service.protocol!=='http:'||service.hostname!=='localhost'||service.pathname!=='/')throw Error('Expected the local dApp.');
const amount=parseStakeAmount(process.env.DEMO_AMOUNT);
const config=loadDemoConfig();
const provider=new ethers.JsonRpcProvider(config.rpcUrl);
const guard=new ActionGuard(amount);
const server=new McpServer({name:'ledger-house',version:'1.0.0'});
let wallet:string|undefined,prover:Awaited<ReturnType<typeof discoverMarketplaceProver>>|undefined;
let action:ReturnType<typeof buildStakeDelegation>|undefined;
let proof:{proof:string;publicInputs:string[]}|undefined;
let mcp:Client|undefined,transport:StdioClientTransport|undefined;
let connecting=false;
let installing=false;
let installedRuntime:string|undefined;
let proverMcpIdentity:{serverName:string;version:string;endpoint:string;transport:'stdio';packageSource:'npm';mcpVersion:string;sdkVersion:string}|undefined;
let readService=false;
let approvedPayment:ApprovedPayment|undefined;
let positionBefore:string|undefined;
const result=(value:unknown)=>({content:[{type:'text' as const,text:redact(JSON.stringify(value))}]});
function register(name:string,description:string,schema:Record<string,z.ZodTypeAny>,handler:(args:any)=>Promise<unknown>){
  server.tool(name,description,schema,async args=>{try{return result(await handler(args));}catch(error){return {...result({ok:false,error:redact(error instanceof Error?error.message:String(error)).slice(0,1200)}),isError:true};}});
}
async function http(url:string,body?:unknown){
  const r=await fetch(url,{signal:AbortSignal.timeout(20000),redirect:'error',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  return {status:r.status,data:await r.json()};
}
function origin(){if(!prover)throw Error('Discover the registered prover first.');return new URL(prover.endpoint).origin;}
async function userPermission(kind:'proof'|'stake',details:Record<string,unknown>){
 const token=process.env.DEMO_AGENT_TOKEN;if(!token)throw Error('User permission channel is unavailable.');
 const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
 const initial=await fetch(service.origin+'/demo/permissions',{method:'POST',headers,body:JSON.stringify({kind,details}),signal:AbortSignal.timeout(10000)});
 if(!initial.ok)throw Error('Could not request user permission.');
 let permission=await initial.json() as Permission;
 while(permission.status==='pending'){
  if(Date.now()>Date.parse(permission.expiresAt))throw Error('User permission expired. Do not retry automatically.');
  await new Promise(resolve=>setTimeout(resolve,750));
  const response=await fetch(service.origin+'/demo/permissions/'+permission.id,{headers,signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('User permission session ended.');permission=await response.json() as typeof permission;
 }
 if(permission.status!=='approved')throw Error('The user rejected or did not approve this action. Stop; do not retry or spend.');
 return permission;
}
function approvalResult(permission:Permission){return {ok:true,approved:true,kind:permission.kind,requestId:permission.id,decidedAt:permission.decidedAt,actor:'User decision in the dApp'};}
function proofPermissionDetails(terms:ApprovedPayment){
 if(!action||!wallet||!prover)throw Error('Missing prepared proof request.');
 return {amount,delegate:wallet,credentialSigner:'****',proverId:prover.agentId,proverUrl:origin(),recipient:terms.payTo,fee:'0.001',payment:'Circle Agent Wallet · Arc nanopayments',chainId:ARC_CHAIN_ID,circuit:'arc_eligibility',scope:'ledger-house',gate:config.gate,action,approvedPayment:terms};
}
function stakePermissionDetails(){
 if(!proof||!wallet||!action)throw Error('Missing verified staking request.');
 return {amount,delegate:wallet,chainId:ARC_CHAIN_ID,gate:config.gate,verifier:config.verifier,proofFingerprint:extractArcPublicMetadata(proof.publicInputs).publicInputsFingerprint,verified:true,transaction:'USDC approval if needed, then stakePacked',payment:'Circle Agent Wallet',action};
}
async function publishPayment(value:Record<string,unknown>){
 const response=await fetch(service.origin+'/demo/protocol/payment',{method:'POST',headers:{Authorization:`Bearer ${process.env.DEMO_AGENT_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('The dApp rejected payment evidence.');
}
async function publishProverMcp(value:Record<string,unknown>){
 const response=await fetch(service.origin+'/demo/protocol/prover-mcp',{method:'POST',headers:{Authorization:`Bearer ${process.env.DEMO_AGENT_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({...proverMcpIdentity,...value}),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('The dApp rejected prover MCP evidence.');
}
register('read_dapp','Read the staking dApp policy and request access. Returns actual service manifest, KYC challenge, connected wallet and balance. No transaction.',{},async()=>{
 const manifest=await http(service.origin+'/.well-known/service.json');
 if(manifest.status!==200||JSON.stringify(manifest.data.chain)!==JSON.stringify(config))throw Error('Untrusted dApp deployment manifest.');
 if(Number((await provider.getNetwork()).chainId)!==ARC_CHAIN_ID)throw Error('Wrong chain.');
 const {listArcAgentWallets}=await publishedSdk();
 wallet=selectAgentDelegate(await listArcAgentWallets('ARC-TESTNET'),env.ARC_AGENT_WALLET);
 process.env.ARC_AGENT_WALLET=wallet;
 const token=new ethers.Contract(config.usdc,['function balanceOf(address) view returns(uint256)'],provider);
 const balance=await token.balanceOf(wallet) as bigint;
 const directKyc=await readCoinbaseKyc(wallet);
 positionBefore=ethers.formatUnits(await new ethers.Contract(config.gate,STAKING_ABI,provider).balances(wallet),6);
 const challenge=await http(service.origin+'/stake',{amount,delegate:wallet});
 if(challenge.status!==402||challenge.data.error!=='PROOF_REQUIRED')throw Error('Unexpected access policy.');
 if(balance<ethers.parseUnits(amount,6))throw Error('Connected Agent Wallet has insufficient USDC.');
 readService=true;
 return {ok:true,step:2,wallet,amount,manifest:manifest.data,challenge:challenge.data,httpStatus:challenge.status,balance:ethers.formatUnits(balance,6),directKyc,positionBefore,walletType:'Circle Agent Wallet'};
});
register('discover_prover','Search the dApp agent marketplace for a compatible prover, then independently validate its ERC-8004 identity, owner and endpoint on Arc. Provider identity is separate from action authorization.',{},async()=>{
 if(!readService)throw Error('Read the dApp policy first.');
 const marketplaceUrl=service.origin+'/marketplace/agents';
 const listing=await http(marketplaceUrl);
 if(listing.status!==200||listing.data.chainId!==ARC_CHAIN_ID||!Array.isArray(listing.data.agents))throw Error('Agent marketplace unavailable.');
 prover=await discoverMarketplaceProver(provider,config.discovery);
 if(!listing.data.agents.some((candidate:any)=>String(candidate.agentId)===prover!.agentId&&candidate.endpoint===prover!.endpoint))throw Error('Marketplace result does not match the verified provider identity.');
 const challenge=await http(origin()+'/api/v1/prove',{circuit:'arc_eligibility',inputs:{}});
 const offers=challenge.data.accepts?.filter((offer:any)=>offer.network==='eip155:5042002'&&offer.extra?.name==='GatewayWalletBatched');
 if(challenge.status!==402||offers?.length!==1)throw Error('Marketplace provider price unavailable.');validateNanoOffer(offers[0],config.discovery.owner,config.usdc);
 guard.discovered=true;
 return {ok:true,step:3,...prover,marketplaceUrl,discovery:'dApp Agent Marketplace',identity:'ERC-8004',capability:'Coinbase KYC eligibility + exact-action authorization proof',priceUSDC:ethers.formatUnits(offers[0].amount,6),usage:origin()+'/.well-known/SKILL.md',guide:origin()+'/api/v1/guide/arc_eligibility'};
});
register('read_prover_guide','Fetch the discovered agent SKILL.md and circuit guide over HTTPS. Read actual integration instructions before connecting its tools.',{},async()=>{
 const base=origin();const paths=['/.well-known/SKILL.md','/api/v1/guide/arc_eligibility'];
 const documents=[];
 for(const path of paths){const r=await fetch(base+path,{redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Prover documentation unavailable.');const text=await r.text();if(text.length>100000)throw Error('Guide exceeds maximum size.');documents.push({url:base+path,text});}
 guard.guideRead=true;
 return {ok:true,documents,interpretation:'arc_eligibility combines Coinbase KYC and the KYC wallet EIP-712 action signature in ONE proof. The staking contract enforces the particular delegate, amount, expiry and nonce. Registry identity is separate. Use the local MCP tools/list schema and dApp chain manifest if generic examples differ.'};
});
register('install_prover_mcp','Install the trusted ZKProofport npm SDK/MCP latest release into a fresh isolated directory after reading the discovered installation guide. Executes a real npm install; arbitrary remote commands are not accepted.',{},async()=>{
 if(!guard.guideRead)throw Error('Read the discovered integration guide first.');
 if(installedRuntime)return {ok:true,alreadyInstalled:true,...publishedProverPackages(installedRuntime),mcpEntry:undefined,sdkEntry:undefined,proveEntry:undefined};
 if(installing)throw Error('npm installation is in progress; wait for its result.');
 installing=true;
 try{
  const installed=await installPublishedProver();installedRuntime=installed.runtimeDirectory;
  const {runtimeDirectory,mcpEntry,sdkEntry,proveEntry,...evidence}=installed;
  return {ok:true,...evidence,source:'npm registry',next:'Connect the installed zkproofport-mcp server and read its tools/list schemas.'};
 }finally{installing=false;}
});
register('connect_prover_mcp','Connect the prover npm package installed in this run over MCP stdio and read actual tools/list schemas. Read the discovered installation guide and install the package first.',{},async()=>{
 if(!guard.guideRead||!installedRuntime)throw Error('Read the discovered integration guide and install the prover npm package first.');
 if(mcp)return {ok:true,alreadyConnected:true};
 if(connecting)throw Error('The MCP connection is in progress; wait for its result.');
 connecting=true;
 let client:Client|undefined;
 try{
  const base=origin();
  const childEnv=Object.fromEntries(Object.entries({...env,PROOFPORT_URL:base,ARC_AGENT_WALLET:wallet,CIRCLE_ACCEPT_TERMS:'1',ZKPROOFPORT_SILENT:'1'}).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
  const installed=publishedProverPackages(installedRuntime);
  transport=new StdioClientTransport({command:process.execPath,args:[installed.mcpEntry],env:childEnv,stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  client=new Client({name:'ledger-house-agent',version:'1.0.0'});
  await client.connect(transport);const listing=await client.listTools();
  const identity=client.getServerVersion();if(identity?.name!=='zkproofport-mcp'||identity.version!==installed.mcpVersion)throw Error('Unexpected prover MCP server identity.');
  proverMcpIdentity={serverName:identity.name,version:identity.version,endpoint:base,transport:'stdio',packageSource:'npm',mcpVersion:installed.mcpVersion,sdkVersion:installed.sdkVersion};
  await publishProverMcp({status:'connected'});mcp=client;guard.mcpConnected=true;
  return {ok:true,server:proverMcpIdentity,transport:'stdio',command:'zkproofport-mcp (installed from npm)',environment:{PROOFPORT_URL:base,ATTESTATION_KEY:'****',ARC_AGENT_WALLET:wallet},tools:listing.tools.filter(t=>['generate_proof','verify_proof','gateway_balance'].includes(t.name))};
 }catch(error){await client?.close().catch(()=>{});throw error;}
 finally{connecting=false;}
});
register('prepare_delegation','Prepare the exact user-approved staking action for the connected Agent Wallet B. The KYC wallet A signs this inside generate_proof. This is separate from ERC-8004 identity discovery.',{amount:z.string()},async args=>{
 if(!wallet||!guard.guideRead)throw Error('Read the service and discovered guide first.');
 if(args.amount!==amount)throw Error('Delegation amount must equal the user-approved amount.');
 if(action)return {ok:true,step:4,wallet,amount,action,credentialSigner:'****',status:'prepared; signing occurs in generate_proof'};
 action=buildStakeDelegation({gate:config.gate,delegate:wallet,amount,expiresAt:Math.floor(Date.now()/1000)+3600,nonce:ethers.hexlify(ethers.randomBytes(16))});
 guard.delegated=true;
 return {ok:true,step:4,wallet,amount,action,credentialSigner:'****',status:'prepared; signing occurs in generate_proof'};
});
register('generate_proof','Call the connected prover MCP generate_proof tool with the prepared delegation and model-selected circuit/scope/payment options. Buys ONE proof. Private credentials are handled by the prover client and the ZKProofport prover, never the staking service. Read the discovered schema before choosing arguments.',{circuit:z.string(),scope:z.string(),pay_on:z.string(),pay_with:z.string()},async args=>{
 if(args.circuit!=='arc_eligibility'||args.scope!=='ledger-house'||args.pay_on!=='arc-testnet-nano'||args.pay_with!=='arc')throw Error('This dApp requires arc_eligibility, ledger-house scope, arc-testnet-nano and the existing arc Agent Wallet.');
 if(!mcp||!action)throw Error('Connect prover MCP and prepare the delegation first.');
 const challenge=await http(origin()+'/api/v1/prove',{circuit:'arc_eligibility',inputs:{}});
 const offers=challenge.data.accepts?.filter((offer:any)=>offer.network==='eip155:5042002'&&offer.extra?.name==='GatewayWalletBatched');
 if(challenge.status!==402||challenge.data.requiresPayment!==true||offers?.length!==1)throw Error('Expected one live Arc Gateway offer.');
 validateNanoOffer(offers[0],config.discovery.owner,config.usdc);
 if(!approvedPayment)throw Error('Missing user-approved payment terms.');
 guard.proof(proofPermissionDetails(approvedPayment));
 const call={...args,action,approved_payment:approvedPayment,max_payment:'0.001'};
 const beforeUSDC=await readGatewayBalance(wallet!);
 const payment={status:'pending',fee:'0.001',method:'x402 / Gateway Nanopayment',wallet:wallet!,beforeUSDC};
 await publishPayment(payment);
 let stopMonitoring=false,paymentConfirmed=false,afterUSDC=beforeUSDC;
 const observeBalance=async()=>{afterUSDC=await readGatewayBalance(wallet!);if(gatewayDebit(beforeUSDC,afterUSDC)){await publishPayment({...payment,status:'confirmed',afterUSDC});paymentConfirmed=true;}};
 const monitor=(async()=>{while(!stopMonitoring&&!paymentConfirmed){await new Promise(resolve=>setTimeout(resolve,2000));if(!stopMonitoring)await readOnlyObservation(observeBalance);}})();
 let response;
 try{await publishProverMcp({status:'calling',tool:'generate_proof',arguments:call});
 response=await mcp.callTool({name:'generate_proof',arguments:call},undefined,{timeout:240000});}
 finally{stopMonitoring=true;await monitor;}
 if(response.isError)throw Error('The prover MCP rejected the paid proof request. Automatic paid retry is disabled.');
 const content=response.content as {type:string;text?:string}[];
 const raw=JSON.parse(content.filter(c=>c.type==='text').map(c=>c.text).join(''));
 if(typeof raw.proof!=='string')throw Error('MCP did not return a proof.');
 proof={proof:raw.proof,publicInputs:normalizeArcPublicInputs(raw.publicInputs)};
 const metadata=extractArcPublicMetadata(proof.publicInputs);
 const saved=await http(service.origin+'/demo/proof',{circuitId:'arc_eligibility',...proof});
 if(saved.status!==200)throw Error('Could not publish the public proof.');
 await readOnlyObservation(()=>publishProverMcp({status:'returned',tool:'generate_proof',arguments:call,proofBytes:(proof!.proof.length-2)/2,publicInputCount:proof!.publicInputs.length}));
 if(!paymentConfirmed)await readOnlyObservation(observeBalance);
 return {ok:true,step:5,source:'Actual prover MCP tools/call response',tool:'generate_proof',arguments:call,proofBytes:(proof.proof.length-2)/2,publicInputCount:proof.publicInputs.length,fingerprint:metadata.publicInputsFingerprint,actionHash:metadata.actionHash,credentialSigner:'****',claims:['Coinbase KYC','same credential holder signed exact-action authorization'],proofCount:1,offer:offers[0],payment:'Circle Agent Wallet / Arc Gateway nanopayment',gateway:{beforeUSDC,afterUSDC,fee:'0.001',confirmed:paymentConfirmed},proofUrl:service.origin+'/demo/proof'};
});
register('request_proof_permission','Ask the user in the dApp to approve the exact discovered prover, 0.001 USDC proof fee and exact-action authorization for the Agent Wallet. Blocks until the user clicks approve or reject. Required before generate_proof. Never grants approval automatically.',{},async()=>{
 if(!guard.guideRead||!guard.mcpConnected||!action||!wallet||!prover)throw Error('Read the guide, connect MCP and prepare the delegation first.');
 // This private preflight never sends Wallet A's address to the dApp or model.
 const credentialWallet=new ethers.Wallet(env.ATTESTATION_KEY!).address;
 const credentialKyc=await readCoinbaseKyc(credentialWallet);
 if(credentialKyc.status!=='found')throw Error('Private Wallet A Coinbase KYC could not be confirmed. No proof payment is authorized.');
 const challenge=await http(origin()+'/api/v1/prove',{circuit:'arc_eligibility',inputs:{}});
 const offers=challenge.data.accepts?.filter((offer:any)=>offer.network==='eip155:5042002'&&offer.extra?.name==='GatewayWalletBatched');
 if(challenge.status!==402||offers?.length!==1)throw Error('Live proof price unavailable.');validateNanoOffer(offers[0],config.discovery.owner,config.usdc);
 const offer=offers[0];
 const terms:ApprovedPayment={network:offer.network,scheme:offer.scheme,amount:offer.amount,asset:offer.asset,payTo:offer.payTo,extra:{name:offer.extra.name,version:offer.extra.version,verifyingContract:offer.extra.verifyingContract}};
 const details=proofPermissionDetails(terms);
 const approved=await userPermission('proof',details);
 guard.approveProof(approved,details);approvedPayment=terms;return approvalResult(approved);
});
register('verify_proof_on_arc','Verify the actual proof with the deployed Arc verifier using eth_call. Staking still checks the delegation policy and verifies again atomically.',{},async()=>{
 if(!proof||!action||!wallet)throw Error('Generate the actual proof first.');
 const gate=new ethers.Contract(config.gate,STAKING_ABI,provider);
 if(ethers.getAddress(await gate.verifier())!==ethers.getAddress(config.verifier))throw Error('The gate verifier changed.');
 const metadata=extractArcPublicMetadata(proof.publicInputs);
 validateProofBinding(metadata,{actionHash:ethers.TypedDataEncoder.from(action.types).hash(action.message),domainSeparator:await gate.domainSeparator(),scope:ethers.id('ledger-house'),signerRoot:await gate.trustedSignerRoot()});
 const verifier=new ethers.Contract(config.verifier,['function verify(bytes,bytes32[]) view returns(bool)'],provider);
 const valid=Boolean(await verifier.verify(proof.proof,proof.publicInputs));
 if(!valid)throw Error('Arc verifier rejected the proof.');
 const block=await provider.getBlock('latest');if(!block)throw Error('Arc block unavailable.');
 const [nonceUsed,actionUsed]=await Promise.all([gate.usedNonces(wallet,ethers.id(action.message.nonce)),gate.usedActions(metadata.actionHash)]);
 const checks={coinbasePolicy:valid,authorizedActor:ethers.getAddress(action.message.delegate)===wallet,exactAction:action.message.action==='stake'&&action.message.amount===ethers.parseUnits(amount,6).toString(),nonceUnused:!nonceUsed&&!actionUsed,deadlineValid:action.message.expiresAt>block.timestamp};
 if(Object.values(checks).some(value=>!value))throw Error('Arc exact-action policy check failed.');guard.verified=true;
 return {ok:true,valid,chainId:ARC_CHAIN_ID,wallet,gate:config.gate,verifier:config.verifier,method:'verify(bytes,bytes32[])',checks,checkedBlock:block.number,deadline:action.message.expiresAt,nonce:action.message.nonce,actionAuthorizationMatched:true,fingerprint:extractArcPublicMetadata(proof.publicInputs).publicInputsFingerprint};
});
register('stake','Execute the user-approved stake through the existing Circle Agent Wallet, after proof verification. Sends approval if needed and stakePacked, then checks the receipt and dApp acceptance. No duplicate transaction attempts.',{amount:z.string()},async args=>{
 if(!wallet||!proof||!action)throw Error('Missing wallet, proof or delegation.');guard.stake(args.amount,stakePermissionDetails());
 const units=ethers.parseUnits(amount,6);
 const token=new ethers.Contract(config.usdc,['function allowance(address,address) view returns(uint256)'],provider);
 let approvalTx:string|null=null;
 if((await token.allowance(wallet,config.gate) as bigint)<units)approvalTx=(await executeFromAgentWallet({wallet,contract:config.usdc,signature:'approve(address,uint256)',args:[config.gate,units.toString()],provider,rpcUrl:config.rpcUrl})).hash;
 const receipt=await executeFromAgentWallet({wallet,contract:config.gate,signature:'stakePacked(uint256,bytes,bytes,uint256,string)',args:[units.toString(),proof.proof,ethers.hexlify(ethers.concat(proof.publicInputs)),String(action.message.expiresAt),action.message.nonce],provider,rpcUrl:config.rpcUrl});
 const iface=new ethers.Interface(STAKING_ABI);
 const event=receipt.logs.filter(log=>log.address.toLowerCase()===config.gate.toLowerCase()).map(log=>{try{return iface.parseLog(log);}catch{return null;}}).find(log=>log?.name==='Staked');
 if(receipt.status!==1||!event||ethers.getAddress(event.args.delegate)!==wallet||event.args.amount!==units||event.args.actionHash.toLowerCase()!==extractArcPublicMetadata(proof.publicInputs).actionHash)throw Error('Staking receipt did not match the authorized action.');
 const accepted=await http(service.origin+'/stake',{txHash:receipt.hash});if(accepted.status!==200||accepted.data.ok!==true)throw Error('dApp rejected the receipt.');
 const positionAfter=await readOnlyObservation(async()=>ethers.formatUnits(await new ethers.Contract(config.gate,STAKING_ABI,provider).balances(wallet),6));
 return {ok:true,step:6,amount,wallet,txHash:receipt.hash,block:receipt.blockNumber,approvalTx,verifiedOn:accepted.data.verifiedOn,receiptStatus:receipt.status,positionBefore,positionAfter};
});
register('request_stake_permission','Ask the user to confirm the exact requested USDC staking transaction after Arc proof verification. Displays the delegate, amount, contract and proof fingerprint. Blocks for a real dApp click; required before stake.',{},async()=>{
 if(!guard.verified||!proof||!wallet)throw Error('Verify the proof on Arc first.');
 const details=stakePermissionDetails();const approved=await userPermission('stake',details);
 guard.approveStake(approved,details);return approvalResult(approved);
});
await server.connect(new StdioServerTransport());
