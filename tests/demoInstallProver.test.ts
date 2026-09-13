import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {installPublishedProver} from '../demo/shared/installProver.ts';
const created:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(created.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(directory:string,version:string){
 const packages:Record<string,unknown>={};
 for(const name of ['sdk','mcp']){
  const path=join(directory,'node_modules','@zkproofport-ai',name);
  await mkdir(join(path,'dist'),{recursive:true});
  await writeFile(join(path,'package.json'),JSON.stringify({name:'@zkproofport-ai/'+name,version,exports:'./dist/index.js'}));
  await writeFile(join(path,'dist/index.js'),'');
  packages['node_modules/@zkproofport-ai/'+name]={version,resolved:`https://registry.npmjs.org/@zkproofport-ai/${name}/-/${name}-${version}.tgz`,integrity:'sha512-test'};
 }
 await writeFile(join(directory,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages}));
}
function executor(sdk='0.2.11',mcp=sdk){return vi.fn(async(args:string[],options:any)=>{
 if(!created.includes(options.cwd))created.push(options.cwd);
 if(args[0]==='view')return {stdout:JSON.stringify(args[1].includes('/sdk@')?sdk:mcp),stderr:''};
 await fixture(options.cwd,sdk);return {stdout:'installed',stderr:''};
});}
describe('isolated published prover installation',()=>{
 it('installs matching versions into a fresh private runtime without inherited credentials',async()=>{
  vi.stubEnv('ATTESTATION_KEY','secret-attestation');vi.stubEnv('NPM_TOKEN','secret-token');vi.stubEnv('NODE_OPTIONS','--require secret-script');
  const exec=executor();const result=await installPublishedProver(exec);
  expect(result.sdkVersion).toBe('0.2.11');expect(result.mcpVersion).toBe('0.2.11');expect(result.exitCode).toBe(0);expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(await readFile(join(result.runtimeDirectory,'package.json'),'utf8')).private).toBe(true);
  expect(exec).toHaveBeenCalledTimes(3);
  const [args,options]=exec.mock.calls.find(([args])=>args[0]==='install')!;
  expect(args).toEqual(['install','--save-exact','--registry=https://registry.npmjs.org','--ignore-scripts','--no-audit','--no-fund','--workspaces=false','@zkproofport-ai/sdk@0.2.11','@zkproofport-ai/mcp@0.2.11']);
  expect(options.env.ATTESTATION_KEY).toBeUndefined();expect(options.env.NPM_TOKEN).toBeUndefined();expect(options.env.NODE_OPTIONS).toBeUndefined();
  expect(options.env.HOME.startsWith(result.runtimeDirectory)).toBe(true);expect(options.timeout).toBeLessThanOrEqual(120000);expect(options.killSignal).toBe('SIGKILL');
  expect(result.npmCommand).toContain('@zkproofport-ai/mcp@0.2.11');
  const second=await installPublishedProver(executor());expect(second.runtimeDirectory).not.toBe(result.runtimeDirectory);
 });
 it.each([['0.2.10','0.2.10'],['0.2.11','0.2.12'],['0.2.11-beta.1','0.2.11-beta.1'],['0.2.11; echo token','0.2.11; echo token']])('rejects invalid versions before install: %s/%s',async(sdk,mcp)=>{
  const exec=executor(sdk,mcp);await expect(installPublishedProver(exec)).rejects.toThrow(/matching stable.*0\.2\.11/);
  expect(exec.mock.calls.some(([args])=>args[0]==='install')).toBe(false);
 });
 it('checks installed versions against the resolved registry versions',async()=>{
  const exec=executor();exec.mockImplementation(async(args,options)=>{
   if(!created.includes(options.cwd))created.push(options.cwd);
   if(args[0]==='view')return {stdout:'"0.2.11"',stderr:''};
   await fixture(options.cwd,'0.2.12');return {stdout:'',stderr:''};
  });
  await expect(installPublishedProver(exec)).rejects.toThrow(/installed versions/);
 });
 it('never exposes subprocess error output',async()=>{
  const exec=vi.fn(async()=>{throw Object.assign(Error('ATTESTATION_KEY=secret'),{code:1,stderr:'NPM_TOKEN=secret'});});
  await expect(installPublishedProver(exec)).rejects.toThrow(/registry lookup failed/);
  try{await installPublishedProver(exec);}catch(error){expect(String(error)).not.toContain('secret');}
 });
});
