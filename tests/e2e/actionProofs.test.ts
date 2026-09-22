/** Real proofs over SDK and stdio MCP, with and without an EIP-712 action.
 * E2E_PAYMENT_NETWORK explicitly selects the offered payment network.
 * E2E_MCP_ENTRY can point to an independently installed published MCP entry.
 * By default this uses workspace packages; the published-package runner must
 * provide an isolated installation rather than report a workspace as npm.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createConfig, generateProof, fromPrivateKey, verifyProof, extractNullifierFromPublicInputs, type ProofResult } from '@zkproofport-ai/sdk';
import { planPayment } from './payer.js';

const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:4002';
const payerKey = process.env.E2E_PAYER_WALLET_KEY;
const rows = [
  { circuit: 'arc_eligibility' as const, key: process.env.ATTESTATION_KEY, keyName: 'ATTESTATION_KEY', chainId: 5042002 },
  { circuit: 'giwa_attestation' as const, key: process.env.GIWA_ATTESTATION_KEY, keyName: 'GIWA_ATTESTATION_KEY', chainId: 91342 },
];
for (const row of rows) if (!row.key) console.warn(`SKIP ${row.circuit}: missing ${row.keyName}`);

for (const protocol of ['sdk', 'mcp'] as const) {
  describe.sequential(`${protocol}: optional actions and stable identity`, () => {
    for (const row of rows) {
      it.skipIf(!row.key)(`${row.circuit}: both modes verify and preserve the nullifier`, async () => {
        if (!payerKey) throw new Error('E2E_PAYER_WALLET_KEY is required for a paid proof run');
        const config = createConfig({ baseUrl });
        const plan = await planPayment(config, row.circuit, payerKey);
        const scope = `e2e:${protocol}:${row.circuit}:action-parity`;
        const action = {
          domain: { name: 'E2E action authorization', version: '1', chainId: row.chainId, verifyingContract: '0x1111111111111111111111111111111111111111' },
          types: { Grant: [{ name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'string' }] },
          primaryType: 'Grant', message: { amount: '1000000', nonce: 'action-parity' },
        };
        let client: Client | undefined;
        try {
          if (protocol === 'mcp') {
            const entry = process.env.E2E_MCP_ENTRY;
            const transport = new StdioClientTransport({
              command: entry ? process.execPath : 'npx',
              args: entry ? [entry] : ['--no-install', 'zkproofport-mcp'],
              env: { ...process.env, PROOFPORT_URL: baseUrl, ATTESTATION_KEY: row.key!, PAYMENT_PRIVATE_KEY: payerKey, PAYMENT_KEY: payerKey } as Record<string, string>,
            });
            client = new Client({ name: 'action-proof-e2e', version: '1.0.0' }, { capabilities: {} });
            await client.connect(transport);
          }
          const prove = async (bound: boolean): Promise<ProofResult> => {
            if (protocol === 'sdk') return generateProof(config, { attestation: fromPrivateKey(row.key!), payment: plan.wallet }, {
              circuit: row.circuit, scope, payOn: plan.payOn, ...(bound ? { action } : {}),
            });
            const result = await client!.callTool({ name: 'generate_proof', arguments: {
              circuit: row.circuit, scope, pay_with: 'key', pay_on: plan.payOn, ...(bound ? { action } : {}),
            } }, undefined, { timeout: 180_000 });
            const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
            expect(result.isError, text).toBeFalsy();
            return JSON.parse(text);
          };
          const plain = await prove(false);
          const bound = await prove(true);
          for (const proof of [plain, bound]) {
            expect(proof.proof).toMatch(/^0x[0-9a-f]+$/i);
            expect(proof.verification.chainId).toBe(row.chainId);
            const verified = await verifyProof(proof);
            expect(verified.valid, verified.error).toBe(true);
          }
          expect(bound.publicInputs).not.toBe(plain.publicInputs);
          const plainNullifier = extractNullifierFromPublicInputs(plain.publicInputs, row.circuit);
          expect(plainNullifier).toMatch(/^0x[0-9a-f]{64}$/i);
          expect(plainNullifier).not.toBe('0x' + '00'.repeat(32));
          expect(extractNullifierFromPublicInputs(bound.publicInputs, row.circuit)).toBe(plainNullifier);
        } finally { await client?.close(); }
      }, 480_000);
    }
  });
}
