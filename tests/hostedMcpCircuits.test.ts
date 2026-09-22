import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { PROVABLE_CIRCUIT_IDS } from '../src/config/circuitIds.js';
import type { Config } from '../src/config/index.js';
const config = { paymentMode: 'testnet', paymentNetworks: 'base-sepolia', paymentProofPrice: '$0.01',
  chainRpcUrl: 'https://sepolia.base.org', ethereumRpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  a2aBaseUrl: 'https://custom.example.com', teeMode: 'local', agentVersion: '0.2.9',
  arcRpcUrl: 'https://rpc.testnet.arc.network', arcChainId: 5042002, giwaRpcUrl: 'https://sepolia-rpc.giwa.io',
  proverPrivateKey: '0x' + '11'.repeat(32), paymentPayTo: '0x' + '22'.repeat(20),
} as Config;
let client: Client;
let server: ReturnType<typeof createMcpServer>;
beforeEach(async () => {
  server = createMcpServer({}, config);
  client = new Client({ name: 'hosted-circuit-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
});
afterEach(async () => { await client.close(); await server.close(); });
const json = (result: any) => JSON.parse(result.content.find((part: any) => part.type === 'text' && part.text.startsWith('{')).text);
describe('hosted MCP circuit parity', () => {
  it('lists every canonical circuit and generic circuit-specific inputs', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ['prove', 'get_guide']) {
      const tool = tools.find(tool => tool.name === name)!;
      for (const id of PROVABLE_CIRCUIT_IDS) expect((tool.inputSchema.properties!.circuit as any).enum).toContain(id);
    }
    expect((tools.find(tool => tool.name === 'prove')!.inputSchema.properties!.inputs as any).required).toBeUndefined();
  });
  it.each(['giwa_attestation', 'oidc_domain_attestation', 'arc_eligibility', 'oidc_domain'])(
    'accepts %s and returns the current deployment REST redirect', async circuit => {
      const result = await client.callTool({ name: 'prove', arguments: { circuit, inputs: { scope: 'test' } } });
      expect(result.isError).not.toBe(true);
      const content = json(result);
      expect(content.rest_endpoint).toBe(`POST ${config.a2aBaseUrl}/api/v1/prove`);
      expect(content.guide_url).toBe(`${config.a2aBaseUrl}/api/v1/guide/${circuit === 'oidc_domain' ? 'oidc_domain_attestation' : circuit}`);
    },
  );
  it.each(PROVABLE_CIRCUIT_IDS)('serves the canonical %s guide', async circuit => {
    const result = await client.callTool({ name: 'get_guide', arguments: { circuit } });
    expect(result.isError).not.toBe(true);
    expect(json(result).circuit_id).toBe(circuit);
  });
  it('rejects unknown circuits', async () => {
    const result = await client.callTool({ name: 'prove', arguments: { circuit: 'invented', inputs: {} } });
    expect(result.isError).toBe(true);
  });
  it('links canonical guides and describes optional action and actual encryption mode', async () => {
    const circuits = json(await client.callTool({ name: 'get_supported_circuits', arguments: {} })).circuits;
    for (const id of PROVABLE_CIRCUIT_IDS) expect(circuits.find((c: any) => c.id === id).guide_url).toBe(`${config.a2aBaseUrl}/api/v1/guide/${id}`);
    const prompt = await client.getPrompt({ name: 'proof_generation_flow' });
    const text = JSON.stringify(prompt);
    for (const id of PROVABLE_CIRCUIT_IDS) expect(text).toContain(id);
    expect(text).toContain('optional');
    expect(text).not.toContain('All proof inputs are end-to-end encrypted');
    expect(text).not.toContain('Groth16');
    expect(text).toContain(config.a2aBaseUrl);
  });
});
