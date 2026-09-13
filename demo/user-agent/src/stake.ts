/** CLI agent: registry discovery -> paid GCP proof -> Circle wallet -> Arc staking. */
import { listArcAgentWallets } from '@zkproofport-ai/sdk';
import { selectAgentDelegate } from './wallet.ts';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers, buildStakeDelegation, STAKING_ABI, ARC_CHAIN_ID } from '../../shared/flow.ts';
import { discoverProver } from '../../shared/discovery.ts';
import { loadDemoConfig, type DemoConfig } from '../../shared/config.ts';
import { executeFromAgentWallet } from '../../shared/circleExecution.ts';
import { normalizeArcPublicInputs, extractArcPublicMetadata } from '../../audit/address-audit.ts';
import { parseStakeAmount } from '../../staking-service/src/recording.ts';

interface Options {service:string;amount:string;payOn:string;payWith:string}
function parseArgs(argv:string[]):Options {
  const get=(flag:string,value:string)=>{const i=argv.indexOf(flag);return i<0?value:argv[i+1];};
  const options={service:get('--service','http://localhost:4100'),amount:parseStakeAmount(get('--amount','1')),
    payOn:get('--pay-on','arc-testnet-nano'),payWith:get('--pay-with','arc')};
  if(options.payOn!=='arc-testnet-nano'||options.payWith!=='arc')throw new Error('This recording uses arc-testnet-nano with the connected Arc Agent Wallet.');
  return options;
}
function say(step:string,detail:string){console.log(`\n[${step}] ${detail}`);}
async function main(){
  const opts=parseArgs(process.argv.slice(2));
  if(!process.env.ATTESTATION_KEY)throw new Error('ATTESTATION_KEY is required in the existing environment.');
  say('1',`Told to stake ${opts.amount} at ${opts.service}`);
  const wallet=selectAgentDelegate(await listArcAgentWallets('ARC-TESTNET'),process.env.ARC_AGENT_WALLET);
  process.env.ARC_AGENT_WALLET=wallet;
  const response=await fetch(`${opts.service}/.well-known/service.json`);
  if(!response.ok)throw new Error('The staking service manifest is unavailable.');
  const service=await response.json() as {name:string;chain:DemoConfig};
  const config=loadDemoConfig();
  if(JSON.stringify(service.chain)!==JSON.stringify(config))throw new Error('The service manifest differs from the locally trusted Arc deployment.');
  if(config.chainId!==ARC_CHAIN_ID)throw new Error('The service is not on Arc Testnet.');
  const provider=new ethers.JsonRpcProvider(config.rpcUrl);
  if(Number((await provider.getNetwork()).chainId)!==ARC_CHAIN_ID)throw new Error('The RPC is not on Arc Testnet.');
  const usdc=new ethers.Contract(config.usdc,['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)'],provider);
  const units=ethers.parseUnits(opts.amount,6);
  const available=await usdc.balanceOf(wallet) as bigint;
  if(available<units)throw new Error(`Connected wallet has ${ethers.formatUnits(available,6)} USDC; requested ${opts.amount}.`);
  say('2',`${service.name} wants a Coinbase KYC proof (arc_eligibility)`);
  const prover=await discoverProver(provider,config.discovery);
  const health=await (await fetch(`${config.discovery.allowedOrigin}/health`,{signal:AbortSignal.timeout(10000)})).json() as {paymentMode?:string;paymentRequired?:boolean;paymentNetworks?:string};
  if(health.paymentMode!=='testnet'||health.paymentRequired!==true||!health.paymentNetworks?.split(',').includes('arc-testnet-nano'))throw new Error('The discovered GCP prover is not ready for paid Arc Testnet nanopayments.');
  say('3',`Registry agent ${prover.agentId} discovered at ${prover.endpoint}`);
  const delegation=buildStakeDelegation({gate:config.gate,delegate:wallet,amount:opts.amount,
    expiresAt:Math.floor(Date.now()/1000)+3600,nonce:ethers.hexlify(ethers.randomBytes(16))});
  say('4',`Wallet A authorises ${wallet} to stake ${opts.amount} USDC; amount and expiry are bound`);
  const dir=mkdtempSync(join(tmpdir(),'agent-'));
  const actionFile=join(dir,'delegation.json');
  writeFileSync(actionFile,JSON.stringify(delegation));
  say('5',`Paying the discovered GCP prover on ${opts.payOn} with the Circle Agent Wallet`);
  const proofFile=join(dir,'proof.json');
  await runProver(prover.endpoint,actionFile,proofFile,opts);
  const proof=JSON.parse(readFileSync(proofFile,'utf8')) as {proof:string;publicInputs:string|string[]};
  const words=normalizeArcPublicInputs(proof.publicInputs);
  const publicMetadata=extractArcPublicMetadata(words);
  const exportProof={circuitId:'arc_eligibility',proof:proof.proof,publicInputs:words};
  writeFileSync(proofFile,JSON.stringify(exportProof));
  const saved=await fetch(`${opts.service}/demo/proof`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(exportProof)});
  if(!saved.ok)throw new Error('The recording server could not retain the public proof for the audit.');
  say('5',`Proof in hand: ${words.length} public inputs; fingerprint=${publicMetadata.publicInputsFingerprint}`);
  say('6',`Submitting a real Arc staking transaction from ${wallet}`);
  if((await usdc.allowance(wallet,config.gate) as bigint)<units){
    await executeFromAgentWallet({wallet,contract:config.usdc,signature:'approve(address,uint256)',args:[config.gate,units.toString()],provider,rpcUrl:config.rpcUrl});
  }
  const receipt=await executeFromAgentWallet({wallet,contract:config.gate,signature:'stakePacked(uint256,bytes,bytes,uint256,string)',
    args:[units.toString(),proof.proof,ethers.hexlify(ethers.concat(words)),String(delegation.message.expiresAt),delegation.message.nonce],provider,rpcUrl:config.rpcUrl});
  const iface=new ethers.Interface(STAKING_ABI);
  const event=receipt.logs.filter(log=>log.address.toLowerCase()===config.gate.toLowerCase()).map(log=>{try{return iface.parseLog(log);}catch{return null;}}).find(log=>log?.name==='Staked');
  if(!event||ethers.getAddress(event.args.delegate)!==wallet||event.args.amount!==units||event.args.actionHash.toLowerCase()!==publicMetadata.actionHash)throw new Error('Receipt did not contain the authorised stake event.');
  const answer=await fetch(`${opts.service}/stake`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txHash:receipt.hash})});
  if(!answer.ok)throw new Error('The service could not verify the staking receipt.');
  say('6',`Staked ${opts.amount} as ${wallet}; tx=${receipt.hash}; block=${receipt.blockNumber}`);
  console.log('KYC credential loaded from environment; address omitted.');
}

/**
 * Run the prover's own command and keep its proof.
 *
 * The prover is a separate service bought from over the network; its command
 * is the published way to talk to it, so this spawns that rather than
 * reimplementing the payment and proof flow here.
 */
function runProver(proverUrl: string, actionFile: string, outFile: string, opts: Options): Promise<void> {
  const proveJs = process.env.PROVE_COMMAND ?? 'zkproofport-prove';
  const base = proverUrl.replace(/\/api\/v1\/prove$/, '');
  return new Promise((resolve, reject) => {
    const child = spawn(
      proveJs.endsWith('.js') ? process.execPath : proveJs,
      [
        ...(proveJs.endsWith('.js') ? [proveJs] : []),
        'arc_eligibility',
        '--action', actionFile,
        '--scope', 'ledger-house',
        '--pay-on', opts.payOn,
        '--pay-with', opts.payWith,
        '--silent',
      ],
      { env: { ...process.env, PROOFPORT_URL: base, CIRCLE_ACCEPT_TERMS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); if(out.length>4*1024*1024){child.kill('SIGTERM');reject(new Error('The prover response exceeded the expected size.'));} });
    // Prover error text may contain the private credential address. Drain but do not print it.
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new Error('The prover CLI could not start.')));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`The prover exited with ${code}.`));
      try {
        const answer = JSON.parse(out) as { proof?: string; publicInputs?: string[]; error?: string };
        if (answer.error) return reject(new Error('The prover refused the proof request.'));
        if (!answer.proof || !answer.publicInputs) {
          return reject(new Error('The prover answered without a proof.'));
        }
        writeFileSync(outFile, JSON.stringify(answer));
        resolve();
      } catch {
        reject(new Error('Could not read the prover response.'));
      }
    });
  });
}

main().catch((error) => {
  console.error(`\nThe agent stopped: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
