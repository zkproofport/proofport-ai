import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';

const KEY='0x'+'11'.repeat(32);
const ADDRESS='0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const mcpRequire=createRequire(new URL('../packages/mcp/package.json',import.meta.url));
const client={connect:vi.fn(),callTool:vi.fn(),close:vi.fn()};
const transport=vi.fn(function(_options:unknown){});
const initialArgv=process.argv;
let stdout:ReturnType<typeof vi.spyOn>,stderr:ReturnType<typeof vi.spyOn>;

beforeEach(()=>{
 vi.resetModules();vi.resetAllMocks();
 client.callTool.mockResolvedValue({content:[{type:'text',text:'{"proof":"0x1234"}'}]});
 vi.doMock(mcpRequire.resolve('@modelcontextprotocol/sdk/client/index.js').replace('/cjs/','/esm/'),()=>({Client:vi.fn(function(){return client;})}));
 vi.doMock(mcpRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js').replace('/cjs/','/esm/'),()=>({StdioClientTransport:transport}));
 vi.stubEnv('ATTESTATION_KEY',KEY);
 stdout=vi.spyOn(console,'log').mockImplementation(()=>{});stderr=vi.spyOn(console,'error').mockImplementation(()=>{});
 vi.spyOn(process,'exit').mockImplementation(((code:number)=>{throw Error(`CLI_EXIT:${code}`);}) as never);
});
afterEach(()=>{process.argv=initialArgv;vi.restoreAllMocks();vi.unstubAllEnvs();});
async function run(args:string[]){process.argv=['node','zkproofport-prove',...args];return import('../packages/mcp/src/prove.ts');}

describe('published proof CLI payment controls and privacy',()=>{
 it('forwards the decimal cap and explicit Arc payer with a four-minute proof timeout',async()=>{
  await run(['coinbase_kyc','--pay-with','arc','--pay-on','arc-testnet-nano','--max-payment','0.001']);
  expect(client.callTool).toHaveBeenCalledExactlyOnceWith({name:'generate_proof',arguments:{circuit:'coinbase_kyc',scope:'proofport',pay_with:'arc',pay_on:'arc-testnet-nano',max_payment:'0.001'}},undefined,{timeout:240000});
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
 it('keeps silent-mode errors machine readable and redacts provider diagnostics',async()=>{
  client.callTool.mockRejectedValue(Error(`unavailable for ${ADDRESS}`));
  await expect(run(['coinbase_kyc','--silent'])).rejects.toThrow('CLI_EXIT:1');
  expect(stdout).not.toHaveBeenCalled();expect(JSON.parse(String(stderr.mock.calls[0][0])).error).toBe('unavailable for ****');
 });
});
