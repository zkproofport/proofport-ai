import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const KEY='0x'+'11'.repeat(32);
const ADDRESS='0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const mcpRequire=createRequire(new URL('../packages/mcp/package.json',import.meta.url));
const client={connect:vi.fn(),callTool:vi.fn(),close:vi.fn()};
const transport=vi.fn(function(_options:unknown){});
const initialArgv=process.argv;
const initialExitCode=process.exitCode;
let directory:string;
let actionFile:string;
const action={domain:{name:'Forum',version:'1',chainId:91342,verifyingContract:'0x'+'11'.repeat(20)},types:{Grant:[{name:'topic',type:'string'}]},primaryType:'Grant',message:{topic:'read'}};
const pending={status:'awaiting_approval',approval_id:'ab'.repeat(16),approval_url:'https://ai.example.com/approve/id#browser',expires_at:new Date(Date.now()+600000).toISOString()};
const reply=(data:unknown)=>({content:[{type:'text',text:JSON.stringify(data)}]});
let stdout:ReturnType<typeof vi.spyOn>,stderr:ReturnType<typeof vi.spyOn>;

beforeEach(async()=>{
 directory=await mkdtemp(join(tmpdir(),'proof-cli-'));actionFile=join(directory,'action.json');await writeFile(actionFile,JSON.stringify(action));
 vi.resetModules();vi.resetAllMocks();
 client.callTool.mockResolvedValue({content:[{type:'text',text:'{"proof":"0x1234"}'}]});
 vi.doMock(mcpRequire.resolve('@modelcontextprotocol/sdk/client/index.js').replace('/cjs/','/esm/'),()=>({Client:vi.fn(function(){return client;})}));
 vi.doMock(mcpRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js').replace('/cjs/','/esm/'),()=>({StdioClientTransport:transport}));
 vi.stubEnv('ATTESTATION_KEY',KEY);
 stdout=vi.spyOn(console,'log').mockImplementation(()=>{});stderr=vi.spyOn(console,'error').mockImplementation(()=>{});
 vi.spyOn(process,'exit').mockImplementation(((code:number)=>{throw Error(`CLI_EXIT:${code}`);}) as never);
});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});process.argv=initialArgv;process.exitCode=initialExitCode;vi.restoreAllMocks();vi.unstubAllEnvs();});
async function run(args:string[]){process.argv=['node','zkproofport-prove',...args];return import('../packages/mcp/src/prove.ts');}

describe('published proof CLI payment controls and privacy',()=>{
 it('forwards the decimal cap and explicit Arc payer with a four-minute proof timeout',async()=>{
  await run(['coinbase_kyc','--pay-with','arc','--pay-on','arc-testnet-nano','--max-payment','0.001']);
  expect(client.callTool).toHaveBeenCalledExactlyOnceWith({name:'generate_proof',arguments:{circuit:'coinbase_kyc',scope:'proofport',pay_with:'arc',pay_on:'arc-testnet-nano',max_payment:'0.001'}},undefined,expect.objectContaining({timeout:240000}));
  expect(client.close).toHaveBeenCalledOnce();expect(stdout).toHaveBeenCalledWith('{"proof":"0x1234"}');
 });
 it.each([[],['-1'],['NaN'],['1e3'],['0.0000001'],['--silent']].map(value=>({value})))('rejects an invalid or missing maximum $value before starting MCP',async({value})=>{
  await expect(run(['coinbase_kyc','--max-payment',...value])).rejects.toThrow('CLI_EXIT:1');
  expect(transport).not.toHaveBeenCalled();expect(client.callTool).not.toHaveBeenCalled();
  expect(stderr.mock.calls.flat().join(' ')).toMatch(/max-payment/);
 });
 it('does not expose the credential holder or private key from tool diagnostics',async()=>{
  client.callTool.mockResolvedValue({content:[{type:'text',text:JSON.stringify({proof:'0x1234',diagnostic:`${KEY} ${ADDRESS.toLowerCase()}`})}]});
  await run(['coinbase_kyc','--pay-with','arc']);
  const output=[...stdout.mock.calls,...stderr.mock.calls].flat().join(' ');
  expect(output).not.toContain(KEY);expect(output.toLowerCase()).not.toContain(ADDRESS.toLowerCase());expect(output).toContain('****');
  expect(transport.mock.calls[0][0]).toMatchObject({stderr:'ignore'});
 });
 it('never logs an OIDC token while passing it to the requested proof tool',async()=>{
  const jwt='private.jwt.credential';await run(['oidc_domain','--jwt',jwt]);
  expect(client.callTool.mock.calls[0][0].arguments.jwt).toBe(jwt);
  expect(stderr.mock.calls.flat().join(' ')).not.toContain(jwt);
 });
 it('without a local credential key waits for human approval and resumes the exact action',async()=>{
  vi.stubEnv('ATTESTATION_KEY','');
  client.callTool.mockResolvedValueOnce(reply(pending)).mockResolvedValueOnce(reply({status:'approved'})).mockResolvedValueOnce(reply({proof:'0xcomplete'}));
  await run(['giwa_attestation','--action',actionFile,'--scope','forum','--max-payment','0.10','--silent']);
  expect(client.callTool.mock.calls.map(call=>call[0].name)).toEqual(['generate_proof','get_action_approval','generate_proof']);
  expect(client.callTool.mock.calls[2][0].arguments).toEqual({...client.callTool.mock.calls[0][0].arguments,approval_id:pending.approval_id});
  expect(stderr.mock.calls.flat().join(' ')).toContain(pending.approval_url);
  expect(stdout).toHaveBeenCalledExactlyOnceWith(JSON.stringify({proof:'0xcomplete'}));
  expect(client.close).toHaveBeenCalledOnce();
 });
 it('a rejected human approval never resumes generation',async()=>{
  client.callTool.mockResolvedValueOnce(reply(pending)).mockResolvedValueOnce(reply({status:'rejected'}));
  await run(['giwa_attestation','--action',actionFile]);
  expect(client.callTool).toHaveBeenCalledTimes(2);expect(stdout).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);expect(client.close).toHaveBeenCalledOnce();
 });
 it('Ctrl+C during approval prevents resume and closes the client',async()=>{
  const listeners=process.listenerCount('SIGINT');
  client.callTool.mockResolvedValueOnce(reply(pending)).mockImplementationOnce(async()=>{process.emit('SIGINT');return reply({status:'approved'});});
  await run(['giwa_attestation','--action',actionFile]);
  expect(client.callTool).toHaveBeenCalledTimes(2);expect(stdout).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(130);expect(client.close).toHaveBeenCalledOnce();
  expect(process.listenerCount('SIGINT')).toBe(listeners);
 });
 it('keeps silent-mode errors machine readable and redacts provider diagnostics',async()=>{
  client.callTool.mockRejectedValue(Error(`unavailable for ${ADDRESS}`));
  await run(['coinbase_kyc','--silent']);
  expect(process.exitCode).toBe(1);expect(client.close).toHaveBeenCalledOnce();
  expect(stdout).not.toHaveBeenCalled();expect(JSON.parse(String(stderr.mock.calls[0][0])).error).toBe('unavailable for ****');
 });
});
