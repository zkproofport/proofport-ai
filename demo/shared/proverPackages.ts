/** Resolve consumer-installed npm packages; never fall back to workspace builds. */
import {createRequire} from 'node:module';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

/** Locate the nearest package exactly as an ESM bare import does, then select import exports. */
function esmPackageEntry(name:string,from:string){
 let directory=dirname(from);
 while(true){
  const manifest=resolve(directory,'node_modules',name,'package.json');
  if(existsSync(manifest)){
   const packageRoot=dirname(realpathSync(manifest));
   const pkg=JSON.parse(readFileSync(manifest,'utf8'));
   const exports=pkg.exports?.['.']??pkg.exports;
   const entry=typeof exports==='string'?exports:exports?.import??exports?.default??pkg.main;
   if(typeof entry!=='string')throw Error('No ESM entry in installed package.');
   return realpathSync(resolve(packageRoot,entry));
  }
  const parent=dirname(directory);if(parent===directory)throw Error('Missing installed ESM package.');directory=parent;
 }
}

export function publishedProverPackages(runtimeDirectory=fileURLToPath(new URL('../runtime/',import.meta.url))){
 const hint='Run npm ci --prefix demo/runtime --workspaces=false to install the published SDK/MCP.';
 try{
  const modules=realpathSync(resolve(runtimeDirectory,'node_modules'));
  const loader=createRequire(resolve(runtimeDirectory,'package.json'));
  const mcpEntry=realpathSync(loader.resolve('@zkproofport-ai/mcp'));
  const sdkEntry=esmPackageEntry('@zkproofport-ai/sdk',resolve(runtimeDirectory,'package.json'));
  const nestedSdk=esmPackageEntry('@zkproofport-ai/sdk',mcpEntry);
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
