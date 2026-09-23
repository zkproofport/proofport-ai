/** Real proofs over SDK and stdio MCP, with and without an EIP-712 action.
 * E2E_PAYMENT_NETWORK explicitly selects the offered payment network.
 * E2E_MCP_ENTRY can point to an independently installed published MCP entry.
 * By default this uses workspace packages; the published-package runner must
 * provide an isolated installation rather than report a workspace as npm.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as sdk from '@zkproofport-ai/sdk';
import { createConfig, fromPrivateKey, verifyProof, extractNullifierFromPublicInputs, type ProofResult } from '@zkproofport-ai/sdk';
import { planPayment } from './payer.js';
import { callToolWithSimulatedApproval, generateProofWithSimulatedApproval } from './simulatedHumanApproval.js';
import { TypedDataEncoder, keccak256, toUtf8Bytes } from 'ethers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
        // The deployed canonical guide declares field order and encoding.
        // Read it before paying; no guessed offsets for either circuit.
        const guideResponse = await fetch(`${baseUrl}/api/v1/guide/${row.circuit}`);
        expect(guideResponse.ok).toBe(true);
        const guide = await guideResponse.json();
        const fields = guide.input_schema.public_fields as string[];
        expect(fields).toEqual(['signal_hash', 'domain_separator', 'action_hash', 'signer_list_merkle_root', 'scope', 'nullifier']);
        const wordCount = guide.constants.verification.public_input_count as number;
        expect(wordCount).toBe(fields.length * 32);
        const decode = (proof: ProofResult): Record<string, string> => {
          expect(proof.publicInputs).toMatch(/^0x[0-9a-f]+$/i);
          const words = proof.publicInputs.slice(2).match(/.{64}/g)!;
          expect(proof.publicInputs.length).toBe(2 + wordCount * 64);
          expect(words).toHaveLength(wordCount);
          const bytes = words.map(word => {
            expect(BigInt(`0x${word}`)).toBeLessThanOrEqual(255n);
            return Number(BigInt(`0x${word}`)).toString(16).padStart(2, '0');
          });
          return Object.fromEntries(fields.map((name, index) => [name, '0x' + bytes.slice(index * 32, (index + 1) * 32).join('')]));
        };
        const config = createConfig({ baseUrl });
        const plan = await planPayment(config, row.circuit, payerKey);
        const scope = `e2e:${protocol}:${row.circuit}:action-parity`;
        const action = {
          domain: { name: 'E2E action authorization', version: '1', chainId: row.chainId, verifyingContract: '0x1111111111111111111111111111111111111111' },
          types: { Grant: [{ name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'string' }] },
          primaryType: 'Grant', message: { amount: '1000000', nonce: 'action-parity' },
        };
        let client: Client | undefined;
        let approvalDirectory: string | undefined;
        try {
          if (protocol === 'mcp') {
            approvalDirectory = await mkdtemp(join(tmpdir(), 'proofport-action-e2e-'));
            const entry = process.env.E2E_MCP_ENTRY;
            const transport = new StdioClientTransport({
              command: entry ? process.execPath : 'npx',
              args: entry ? [entry] : ['--no-install', 'zkproofport-mcp'],
              env: { ...process.env, PROOFPORT_URL: baseUrl, ATTESTATION_KEY: row.key!, PAYMENT_PRIVATE_KEY: payerKey, PAYMENT_KEY: payerKey,
                ZKPROOFPORT_APPROVAL_DIR: approvalDirectory } as Record<string, string>,
            });
            client = new Client({ name: 'action-proof-e2e', version: '1.0.0' }, { capabilities: {} });
            await client.connect(transport);
          }
          const prove = async (bound: boolean): Promise<ProofResult> => {
            if (protocol === 'sdk') return generateProofWithSimulatedApproval(sdk, config, { attestation: fromPrivateKey(row.key!), payment: plan.wallet }, {
              circuit: row.circuit, scope, payOn: plan.payOn, ...(bound ? { action } : {}),
            });
            const result = await callToolWithSimulatedApproval(client!, config, fromPrivateKey(row.key!), 'generate_proof', {
              circuit: row.circuit, scope, pay_with: 'key', pay_on: plan.payOn, ...(bound ? { action } : {}),
            }, 180_000) as { content: Array<{ text?: string }>; isError?: boolean };
            const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
            expect(result.isError, text).toBeFalsy();
            return JSON.parse(text);
          };
          const plain = await prove(false);
          const bound = await prove(true);
          for (const proof of [plain, bound]) {
            expect(proof.proof).toMatch(/^0x[0-9a-f]+$/i);
            expect(proof.verification?.chainId).toBe(row.chainId);
            expect(proof.verification?.verifierAddress.toLowerCase()).toBe(guide.constants.verification.verifier_address.toLowerCase());
            const verified = await verifyProof(proof);
            expect(verified.valid, verified.error).toBe(true);
          }
          const identityInputs = decode(plain);
          const actionInputs = decode(bound);
          const zero = '0x' + '00'.repeat(32);
          expect(identityInputs.domain_separator).toBe(zero);
          expect(identityInputs.action_hash).toBe(zero);
          expect(identityInputs.signal_hash).not.toBe(zero);
          expect(actionInputs.signal_hash).toBe(zero);
          expect(actionInputs.domain_separator).toBe(TypedDataEncoder.hashDomain(action.domain).toLowerCase());
          expect(actionInputs.action_hash).toBe(TypedDataEncoder.from(action.types).hash(action.message).toLowerCase());
          for (const inputs of [identityInputs, actionInputs]) expect(inputs.scope).toBe(keccak256(toUtf8Bytes(scope)));
          expect(actionInputs.signer_list_merkle_root).toBe(identityInputs.signer_list_merkle_root);
          expect(actionInputs.signer_list_merkle_root).not.toBe(zero);
          expect(bound.publicInputs).not.toBe(plain.publicInputs);
          const plainNullifier = extractNullifierFromPublicInputs(plain.publicInputs, row.circuit);
          expect(plainNullifier).toMatch(/^0x[0-9a-f]{64}$/i);
          expect(plainNullifier).not.toBe('0x' + '00'.repeat(32));
          expect(extractNullifierFromPublicInputs(bound.publicInputs, row.circuit)).toBe(plainNullifier);
        } finally {
          await client?.close();
          if (approvalDirectory) await rm(approvalDirectory, { recursive: true, force: true });
        }
      }, 480_000);
    }
  });
}
