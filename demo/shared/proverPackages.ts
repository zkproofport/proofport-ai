/** Resolve consumer-installed npm packages; never fall back to workspace builds. */
import {createRequire} from 'node:module';
import {readFileSync,realpathSync} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export function publishedProverPackages(runtimeDirectory=fileURLToPath(new URL('../runtime/',import.meta.url))){
 const hint='Run npm ci --prefix demo/runtime --workspaces=false to install the published SDK/MCP.';
 try{
  const modules=realpathSync(resolve(runtimeDirectory,'node_modules'));
  const loader=createRequire(resolve(runtimeDirectory,'package.json'));
  const mcpEntry=realpathSync(loader.resolve('@zkproofport-ai/mcp'));
  const sdkEntry=realpathSync(loader.resolve('@zkproofport-ai/sdk'));
  const nestedSdk=realpathSync(createRequire(mcpEntry).resolve('@zkproofport-ai/sdk'));
  if([mcpEntry,sdkEntry,nestedSdk].some(path=>!path.startsWith(modules+sep))||nestedSdk!==sdkEntry)throw Error('Workspace links or mismatched SDK resolution are not allowed.');
  const mcp=JSON.parse(readFileSync(resolve(dirname(mcpEntry),'../package.json'),'utf8'));
  const sdk=JSON.parse(readFileSync(resolve(dirname(sdkEntry),'../package.json'),'utf8'));
  if(mcp.name!=='@zkproofport-ai/mcp'||sdk.name!=='@zkproofport-ai/sdk')throw Error('Installed package identity does not match the requested SDK/MCP.');
  const lock=JSON.parse(readFileSync(resolve(runtimeDirectory,'package-lock.json'),'utf8'));
  for(const pkg of [sdk,mcp]){
   const entry=lock.packages?.['node_modules/'+pkg.name];
   if(!entry||entry.link||entry.version!==pkg.version||!entry.resolved?.startsWith('https://registry.npmjs.org/')||!entry.integrity?.startsWith('sha512-'))throw Error('Published package lock does not match installed packages.');
   const stable=typeof pkg.version==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(pkg.version);
   if(!stable||(BigInt(stable[1])===0n&&(BigInt(stable[2])<2n||(BigInt(stable[2])===2n&&BigInt(stable[3])<11n))))throw Error('This demo requires stable Arc-enabled SDK/MCP versions >=0.2.11.');
  }
  return {mcpEntry,sdkEntry,proveEntry:resolve(dirname(mcpEntry),'prove.js'),packageSource:'npm' as const,mcpVersion:mcp.version as string,sdkVersion:sdk.version as string};
 }catch(error){throw Error(`${hint} ${error instanceof Error?error.message:String(error)}`);}
}
export async function publishedSdk(){
 return await import(pathToFileURL(publishedProverPackages().sdkEntry).href) as typeof import('@zkproofport-ai/sdk');
}
