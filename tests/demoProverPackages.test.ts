import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {publishedProverPackages} from '../demo/shared/proverPackages.ts';

const directories:string[]=[];
function writeJson(path:string,value:unknown){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));}
function installPackage(modules:string,name:string,version:string){
 const directory=join(modules,name);mkdirSync(join(directory,'dist'),{recursive:true});
 writeJson(join(directory,'package.json'),{name,version,type:'module',main:'dist/index.js',exports:'./dist/index.js'});
 writeFileSync(join(directory,'dist/index.js'),'export {};');writeFileSync(join(directory,'dist/prove.js'),'export {};');return directory;
}
function fixture(version='0.2.11'){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'published-prover-test-')));directories.push(root);
 const runtime=join(root,'runtime'),modules=join(runtime,'node_modules');
 writeJson(join(runtime,'package.json'),{name:'fixture',private:true});
 const sdk=installPackage(modules,'@zkproofport-ai/sdk',version),mcp=installPackage(modules,'@zkproofport-ai/mcp',version);
 const packages=Object.fromEntries(['sdk','mcp'].map(name=>[`node_modules/@zkproofport-ai/${name}`,{version,resolved:`https://registry.npmjs.org/@zkproofport-ai/${name}/-/${name}-${version}.tgz`,integrity:'sha512-fixture'}]));
 const lockPath=join(runtime,'package-lock.json');writeJson(lockPath,{lockfileVersion:3,packages});
 return {root,runtime,modules,sdk,mcp,lockPath};
}
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});

describe('consumer-installed npm prover package resolution',()=>{
 it.each(['0.2.11','0.2.100','0.3.0','1.0.0'])('accepts stable installed package version %s',version=>{
  const f=fixture(version);expect(publishedProverPackages(f.runtime)).toEqual({mcpEntry:join(f.mcp,'dist/index.js'),sdkEntry:join(f.sdk,'dist/index.js'),proveEntry:join(f.mcp,'dist/prove.js'),packageSource:'npm',mcpVersion:version,sdkVersion:version});
 });
 it.each(['0.2.10','0.1.99','0.0.99','0.2.11-rc.1','1.0.0-beta.1','01.2.11'])('rejects old or nonstable version %s',version=>{
  expect(()=>publishedProverPackages(fixture(version).runtime)).toThrow(/0\.2\.11/);
 });
 it('refuses an SDK symlink to a workspace build',()=>{
  const f=fixture(),workspace=installPackage(join(f.root,'workspace'),'@zkproofport-ai/sdk','0.2.11');
  rmSync(f.sdk,{recursive:true});symlinkSync(workspace,f.sdk,'dir');
  expect(()=>publishedProverPackages(f.runtime)).toThrow(/Workspace/);
 });
 it('refuses ancestor node_modules fallback when the consumer install is missing',()=>{
  const f=fixture();rmSync(f.sdk,{recursive:true});rmSync(f.mcp,{recursive:true});
  installPackage(join(f.root,'node_modules'),'@zkproofport-ai/sdk','0.2.11');installPackage(join(f.root,'node_modules'),'@zkproofport-ai/mcp','0.2.11');
  expect(()=>publishedProverPackages(f.runtime)).toThrow(/Workspace/);
 });
 it('refuses an MCP nested SDK different from the consumer SDK',()=>{
  const f=fixture();installPackage(join(f.mcp,'node_modules'),'@zkproofport-ai/sdk','0.2.12');
  expect(()=>publishedProverPackages(f.runtime)).toThrow(/mismatched SDK/);
 });
 it.each([{version:'0.2.12'},{resolved:'file:../../packages/sdk'},{resolved:'https://registry.npmjs.org.attacker.invalid/sdk.tgz'},{integrity:''},{link:true}])('rejects mismatched or nonpublished lock provenance %j',change=>{
  const f=fixture(),lock=JSON.parse(readFileSync(f.lockPath,'utf8'));Object.assign(lock.packages['node_modules/@zkproofport-ai/sdk'],change);writeJson(f.lockPath,lock);
  expect(()=>publishedProverPackages(f.runtime)).toThrow(/lock/);
 });
 it('refuses a package whose installed manifest impersonates another locked name',()=>{
  const f=fixture(),path=join(f.sdk,'package.json'),pkg=JSON.parse(readFileSync(path,'utf8'));pkg.name='another-sdk';writeJson(path,pkg);
  const lock=JSON.parse(readFileSync(f.lockPath,'utf8'));lock.packages['node_modules/another-sdk']=lock.packages['node_modules/@zkproofport-ai/sdk'];writeJson(f.lockPath,lock);
  expect(()=>publishedProverPackages(f.runtime)).toThrow(/identity/);
 });
});
