/** Non-paying stdio MCP check of both action-preparation modes.
 * Actual attestation RPC reads and wallet signatures; no proof fee or transaction.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { hashTypedAction } from '@zkproofport-ai/sdk';

const rows = [
  { circuit: 'arc_eligibility', key: process.env.ATTESTATION_KEY, keyName: 'ATTESTATION_KEY', chainId: 5042002 },
  { circuit: 'giwa_attestation', key: process.env.GIWA_ATTESTATION_KEY, keyName: 'GIWA_ATTESTATION_KEY', chainId: 91342 },
];
for (const row of rows) if (!row.key) console.warn(`SKIP MCP preparation ${row.circuit}: ${row.keyName} missing`);
describe.sequential('MCP step-by-step action preparation', () => {
  for (const row of rows) for (const bound of [false, true]) {
    it.skipIf(!row.key)(`${row.circuit}: prepares ${bound ? 'a supplied action' : 'without action'}`, async () => {
      const entry = process.env.E2E_MCP_ENTRY;
      const transport = new StdioClientTransport({
        command: entry ? process.execPath : 'npx', args: entry ? [entry] : ['--no-install', 'zkproofport-mcp'],
        env: { ...process.env, PROOFPORT_URL: process.env.E2E_BASE_URL || 'http://localhost:4002', ATTESTATION_KEY: row.key! } as Record<string, string>,
      });
      const client = new Client({ name: 'mcp-action-preparation-e2e', version: '1.0.0' }, { capabilities: {} });
      try {
        await client.connect(transport);
        const action = {
          domain: { name: 'E2E preparation', version: '1', chainId: row.chainId, verifyingContract: '0x1111111111111111111111111111111111111111' },
          types: { Grant: [{ name: 'amount', type: 'uint256' }] }, primaryType: 'Grant', message: { amount: '1' },
        };
        const result = await client.callTool({ name: 'prepare_inputs', arguments: {
          circuit: row.circuit, scope: 'e2e:mcp:prepare-action', ...(bound ? { action } : {}),
        } }, undefined, { timeout: 90_000 });
        const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
        // Never put successful private witness inputs into test output.
        expect(result.isError, result.isError ? text : '').not.toBe(true);
        const prepared = JSON.parse(text);
        expect(prepared.error).toBeUndefined();
        expect(Object.keys(prepared).length).toBeGreaterThan(0);
        if (bound) {
          expect(prepared.action_hash).toBe(hashTypedAction(action).actionHash);
          expect(prepared.domain_separator).toBe(hashTypedAction(action).domainSeparator);
        }
      } finally { await client.close(); }
    }, 120_000);
  }
});
