import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {claudeEnvironment} from './staking-service/src/claudeSession.ts';
import { loadDemoConfig } from './shared/config.ts';
import {publishedProverPackages} from './shared/proverPackages.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const config=loadDemoConfig();
const packages=publishedProverPackages();
// Private env files are read only by the local MCP client, never by this service.
const env={...claudeEnvironment(process.env)};
for(const name of ['.env.development','.env.test']){
  const path=resolve(root,name);
  if(!existsSync(path))throw new Error(`${name} is missing in proofport-ai.`);
}
if(process.env.ARC_AGENT_WALLET)env.ARC_AGENT_WALLET=process.env.ARC_AGENT_WALLET;
const port=Number(process.env.RECORDING_PORT ?? '4100');
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid RECORDING_PORT.');
Object.assign(env,{CIRCLE_ACCEPT_TERMS:'1',PROVE_COMMAND:packages.proveEntry,
  PROVER_URL:config.discovery.allowedOrigin,PORT:String(port)});
console.log(`Published npm runtime: MCP ${packages.mcpVersion}, SDK ${packages.sdkVersion}`);
let occupied=false;
try{await fetch(`http://localhost:${port}/health`,{signal:AbortSignal.timeout(1500)});occupied=true;}catch{}
if(occupied)throw new Error(`Port ${port} is occupied; choose an unused RECORDING_PORT; keep the existing process running.`);
const child=spawn(process.execPath,['demo/staking-service/src/server.ts'],{cwd:root,env,stdio:'inherit'});
let stopping=false;
function stop(){if(stopping)return;stopping=true;child.kill('SIGTERM');}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
child.on('error',()=>{console.error('The recording server could not start.');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=stopping?0:(code ?? 1);});
console.log(`Recording page: http://localhost:${port}`);
console.log(`Proof host: deployed GCP (${config.discovery.allowedOrigin}); discovery uses Arc ERC-8004.`);
console.log('Agent: enter your instruction in the dApp and select Ask agent.');
console.log('Ctrl-C stops this recording server; it does not stop the deployed prover.');
