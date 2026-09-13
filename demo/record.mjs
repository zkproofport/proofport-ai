import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { loadDemoConfig } from './shared/config.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const config=loadDemoConfig();
const env={};
for(const name of ['.env.development','.env.test']){
  const path=resolve(root,name);
  if(!existsSync(path))throw new Error(`${name} is missing in proofport-ai.`);
  Object.assign(env,dotenv.parse(readFileSync(path)));
}
Object.assign(env,process.env);
const port=Number(process.env.RECORDING_PORT ?? '4100');
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid RECORDING_PORT.');
Object.assign(env,{CIRCLE_ACCEPT_TERMS:'1',PROVE_COMMAND:resolve(root,'packages/mcp/dist/prove.js'),
  PROVER_URL:config.discovery.allowedOrigin,PORT:String(port)});
for(const name of ['CDP_API_KEY_ID','CDP_API_KEY_SECRET','CDP_WALLET_SECRET','ARC_WALLET_DEBUG'])delete env[name];
if(!env.ATTESTATION_KEY)throw new Error('ATTESTATION_KEY is missing from the existing environment.');
if(!existsSync(env.PROVE_COMMAND))throw new Error('Build packages/sdk and packages/mcp before recording.');
let occupied=false;
try{await fetch(`http://localhost:${port}/health`,{signal:AbortSignal.timeout(1500)});occupied=true;}catch{}
if(occupied)throw new Error(`Port ${port} is occupied; stop that recording process before restarting.`);
const child=spawn(process.execPath,['demo/staking-service/src/server.ts'],{cwd:root,env,stdio:'inherit'});
let stopping=false;
function stop(){if(stopping)return;stopping=true;child.kill('SIGTERM');}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
child.on('error',()=>{console.error('The recording server could not start.');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=stopping?0:(code ?? 1);});
console.log(`Recording page: http://localhost:${port}`);
console.log(`Proof host: deployed GCP (${config.discovery.allowedOrigin}); discovery uses Arc ERC-8004.`);
console.log(`CLI: curl -s http://localhost:${port}/demo/run -H 'Content-Type: application/json' -d '{"amount":"1"}'`);
console.log('Ctrl-C stops this recording server; it does not stop the deployed prover.');
