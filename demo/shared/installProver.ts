/** Install only the two trusted, registry-published prover packages in a fresh runtime. */
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishedProverPackages} from './proverPackages.ts';

export interface NpmExecutionOptions {
 cwd:string;env:NodeJS.ProcessEnv;timeout:number;maxBuffer:number;killSignal:'SIGKILL';
}
export type NpmExecutor=(args:string[],options:NpmExecutionOptions)=>Promise<{stdout:string;stderr:string}>;
const executeNpm:NpmExecutor=(args,options)=>new Promise((resolve,reject)=>{
 execFile('npm',args,{...options,encoding:'utf8',shell:false},(error,stdout,stderr)=>{
  if(error)reject(error);else resolve({stdout,stderr});
 });
});
const registry='--registry=https://registry.npmjs.org';
const packages=['@zkproofport-ai/sdk','@zkproofport-ai/mcp'] as const;
function stableVersion(stdout:string):string|null {
 let value:unknown;try{value=JSON.parse(stdout);}catch{return null;}
 if(typeof value!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))return null;
 const [major,minor,patch]=value.split('.').map(Number);
 if(![major,minor,patch].every(Number.isSafeInteger))return null;
 return major>0||minor>2||(minor===2&&patch>=11)?value:null;
}

/** The executor argument is a test seam, never an argument of the agent-facing tool. */
export async function installPublishedProver(execute:NpmExecutor=executeNpm) {
 const started=Date.now(),deadline=started+120_000;
 const runtimeDirectory=await mkdtemp(join(tmpdir(),'zkproofport-prover-'));
 try {
  const isolatedHome=join(runtimeDirectory,'.npm-home');
  await mkdir(isolatedHome,{mode:0o700});
  await writeFile(join(runtimeDirectory,'package.json'),JSON.stringify({name:'zkproofport-prover-runtime',private:true,type:'module'}),{mode:0o600});
  const userConfig=join(isolatedHome,'user.npmrc'),globalConfig=join(isolatedHome,'global.npmrc');
  await Promise.all([writeFile(userConfig,'',{mode:0o600}),writeFile(globalConfig,'',{mode:0o600})]);
  // No login, signing key, npm token, NODE_OPTIONS or inherited npm configuration crosses this boundary.
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH??'/usr/bin:/bin',HOME:isolatedHome,TMPDIR:tmpdir(),LANG:'C.UTF-8',CI:'1',
   NPM_CONFIG_USERCONFIG:userConfig,NPM_CONFIG_GLOBALCONFIG:globalConfig,NPM_CONFIG_CACHE:join(isolatedHome,'cache')};
  const run=async(args:string[],stage:string)=>{
   const timeout=deadline-Date.now();
   if(timeout<=0)throw Error('Published prover installation exceeded its 120-second deadline.');
   try{return await execute(args,{cwd:runtimeDirectory,env,timeout,maxBuffer:1024*1024,killSignal:'SIGKILL'});}
   catch(error){
    const code=typeof (error as {code?:unknown})?.code==='number'?(error as {code:number}).code:null;
    throw Error(`Published prover ${stage} failed${code===null?'':` (exit ${code})`}. No package runtime was accepted.`);
   }
  };
  const lookups=await Promise.allSettled(packages.map(name=>run(['view',`${name}@latest`,'version','--json',registry,'--ignore-scripts','--no-audit','--no-fund','--workspaces=false'],'registry lookup')));
  const failed=lookups.find(result=>result.status==='rejected');
  if(failed?.status==='rejected')throw failed.reason;
  const versions=lookups.map(result=>result.status==='fulfilled'?stableVersion(result.value.stdout):null);
  if(!versions[0]||versions[0]!==versions[1])throw Error('The registry must publish matching stable SDK/MCP versions >=0.2.11 before installation.');
  const version=versions[0];
  const args=['install','--save-exact',registry,'--ignore-scripts','--no-audit','--no-fund','--workspaces=false',...packages.map(name=>`${name}@${version}`)];
  await run(args,'npm install');
  let installed:ReturnType<typeof publishedProverPackages>;
  try{installed=publishedProverPackages(runtimeDirectory);}catch{throw Error('Published prover package provenance validation failed. No package runtime was accepted.');}
  if(installed.sdkVersion!==version||installed.mcpVersion!==version)throw Error('The installed versions differ from the resolved npm registry versions.');
  if(Date.now()>deadline)throw Error('Published prover installation exceeded its 120-second deadline.');
  return {runtimeDirectory,...installed,npmCommand:['npm',...args].join(' '),durationMs:Date.now()-started,exitCode:0,observedAt:new Date().toISOString()};
 } catch(error) {
  await rm(runtimeDirectory,{recursive:true,force:true});
  throw error;
 }
}
