/**
 * MCP client proofs against a real backend.
 * Direct Vitest runs resolve workspace packages. To verify exact npm artifacts:
 * E2E_BASE_URL=https://stg-ai.zkproofport.app npm run test:e2e:published
 * The isolated runner supplies published SDK/MCP entry paths and wallet peers.
 * Requires .env.test attestation/payer keys, GIWA_ATTESTATION_KEY for GIWA,
 * and E2E_OIDC_JWT or a valid gcloud identity token for OIDC.
 */

import { execSync } from 'child_process';
import { verifyProof } from '@zkproofport-ai/sdk';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';
const ATTESTATION_KEY = process.env.ATTESTATION_KEY;
const PAYER_KEY = process.env.E2E_PAYER_WALLET_KEY;

function getOidcJwt(): string | undefined {
  if (process.env.E2E_OIDC_JWT) return process.env.E2E_OIDC_JWT;
  try {
    return execSync('gcloud auth print-identity-token', { encoding: 'utf-8' }).trim();
  } catch {
    return undefined;
  }
}
const OIDC_JWT = getOidcJwt();
if (!OIDC_JWT) console.warn('SKIP OIDC proof: E2E_OIDC_JWT absent and gcloud identity token unavailable');

describe('MCP Client E2E — npm @zkproofport-ai/mcp', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    if (!ATTESTATION_KEY) throw new Error('ATTESTATION_KEY required in .env.test');
    if (!PAYER_KEY) throw new Error('E2E_PAYER_WALLET_KEY required in .env.test');

    // Health check
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.ok).toBe(true);

    // Spawn MCP server from npm package
    transport = new StdioClientTransport({
      command: process.env.E2E_MCP_ENTRY ? process.execPath : 'npx',
      args: process.env.E2E_MCP_ENTRY ? [process.env.E2E_MCP_ENTRY] : ['--no-install', 'zkproofport-mcp'],
      env: {
        ...process.env,
        PROOFPORT_URL: BASE_URL,
        ATTESTATION_KEY: ATTESTATION_KEY!,
        PAYMENT_PRIVATE_KEY: PAYER_KEY!,
      },
    });

    client = new Client(
      { name: 'mcp-npm-e2e-test', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try { await client?.close(); } catch {}
  });

  describe('get_supported_circuits', () => {
    it('should list all 5 circuits', async () => {
      const result = await client.callTool({
        name: 'get_supported_circuits',
        arguments: {},
      });
      const text = (result.content as any[])[0]?.text;
      const data = JSON.parse(text);

      expect(data.circuits).toBeDefined();
      expect(Object.keys(data.circuits)).toContain('coinbase_attestation');
      expect(Object.keys(data.circuits)).toContain('coinbase_country_attestation');
      expect(Object.keys(data.circuits)).toContain('oidc_domain_attestation');
      expect(Object.keys(data.circuits)).toContain('arc_eligibility');
      expect(Object.keys(data.circuits)).toContain('giwa_attestation');
    });
  });

  describe('generate_proof', () => {
    it('coinbase_kyc: full E2E proof generation', async () => {
      const result = await client.callTool({
        name: 'generate_proof',
        arguments: {
          circuit: 'coinbase_kyc',
          pay_with: 'key',
          pay_on: process.env.E2E_PAYMENT_NETWORK,
          scope: 'e2e-test:npm-mcp-kyc',
        },
      });
      const text = (result.content as any[])[0]?.text;
      const data = JSON.parse(text);

      // Say WHAT the tool answered. `expected true to be falsy` hid
      // "Circle Gateway failed to settle arc-testnet-nano:
      // insufficient_balance" behind a boolean for a whole staging run.
      expect(result.isError, `generate_proof failed: ${text}`).toBeFalsy();
      expect(data.proof).toBeTruthy();
      const verified = await verifyProof(data);
      expect(verified.valid, verified.error).toBe(true);
      expect(data.proof.startsWith('0x')).toBe(true);
      expect(data.publicInputs).toBeTruthy();
      // paymentTxHash only present when payment is required (not in free tier)
      if (data.paymentTxHash) expect(data.paymentTxHash).toMatch(/^0x/);
    }, 120_000);

    it('coinbase_country: full E2E proof generation', async () => {
      const result = await client.callTool({
        name: 'generate_proof',
        arguments: {
          circuit: 'coinbase_country',
          pay_with: 'key',
          pay_on: process.env.E2E_PAYMENT_NETWORK,
          scope: 'e2e-test:npm-mcp-country',
          country_list: ['US', 'KR'],
          is_included: true,
        },
      });
      const text = (result.content as any[])[0]?.text;
      const data = JSON.parse(text);

      // Say WHAT the tool answered. `expected true to be falsy` hid
      // "Circle Gateway failed to settle arc-testnet-nano:
      // insufficient_balance" behind a boolean for a whole staging run.
      expect(result.isError, `generate_proof failed: ${text}`).toBeFalsy();
      expect(data.proof).toBeTruthy();
      const verified = await verifyProof(data);
      expect(verified.valid, verified.error).toBe(true);
    }, 120_000);

    it.skipIf(!OIDC_JWT)('oidc_domain: full E2E proof generation', async () => {
      const result = await client.callTool({
        name: 'generate_proof',
        arguments: {
          circuit: 'oidc_domain',
          pay_with: 'key',
          pay_on: process.env.E2E_PAYMENT_NETWORK,
          scope: 'e2e-test:npm-mcp-oidc',
          jwt: OIDC_JWT,
        },
      });
      const text = (result.content as any[])[0]?.text;
      const data = JSON.parse(text);

      // Say WHAT the tool answered. `expected true to be falsy` hid
      // "Circle Gateway failed to settle arc-testnet-nano:
      // insufficient_balance" behind a boolean for a whole staging run.
      expect(result.isError, `generate_proof failed: ${text}`).toBeFalsy();
      expect(data.proof).toBeTruthy();
      const verified = await verifyProof(data);
      expect(verified.valid, verified.error).toBe(true);
      expect(data.proof.startsWith('0x')).toBe(true);
    }, 120_000);
  });

  describe('step-by-step flow', () => {
    it('prepare_inputs + request_challenge for coinbase_kyc', async () => {
      // Step 1: prepare_inputs
      const prepResult = await client.callTool({
        name: 'prepare_inputs',
        arguments: {
          circuit: 'coinbase_kyc',
          pay_with: 'key',
          pay_on: process.env.E2E_PAYMENT_NETWORK,
          scope: 'e2e-test:npm-mcp-steps',
        },
      });
      const prepText = (prepResult.content as any[])[0]?.text;
      const prepData = JSON.parse(prepText);
      expect(prepResult.isError).toBeFalsy();
      expect(prepData).toBeDefined();

      // Step 2: request_challenge
      const chalResult = await client.callTool({
        name: 'request_challenge',
        arguments: {
          circuit: 'coinbase_kyc',
          inputs: prepData,
        },
      });
      const chalText = (chalResult.content as any[])[0]?.text;
      const chalData = JSON.parse(chalText);
      expect(chalResult.isError).toBeFalsy();
      expect(chalData.nonce).toBeTruthy();
      expect(chalData.payment).toBeDefined();
    }, 60_000);
  });
});
