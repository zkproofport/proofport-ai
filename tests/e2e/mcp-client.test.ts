/**
 * MCP Client E2E Tests — npm Package
 *
 * Tests the published @zkproofport-ai/mcp npm package against a real backend.
 * The MCP server is spawned via `npx @zkproofport-ai/mcp` (npm binary)
 * and connected via MCP SDK StdioClientTransport.
 *
 * Prerequisites:
 *   - `npm install @zkproofport-ai/mcp` in proofport-ai root
 *   - Backend running at E2E_BASE_URL (default: http://localhost:4002)
 *   - .env.test with ATTESTATION_KEY, E2E_PAYER_WALLET_KEY
 *   - For OIDC: E2E_OIDC_JWT
 *
 * Run: npx vitest run --project e2e tests/e2e/mcp-client.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';
const ATTESTATION_KEY = process.env.ATTESTATION_KEY;
const PAYER_KEY = process.env.E2E_PAYER_WALLET_KEY;
const OIDC_JWT = process.env.E2E_OIDC_JWT;

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
      command: 'npx',
      args: ['-y', '@zkproofport-ai/mcp'],
      env: {
        ...process.env,
        PROOFPORT_URL: BASE_URL,
        ATTESTATION_KEY: ATTESTATION_KEY!,
        PAYMENT_KEY: PAYER_KEY!,
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
    it('should list all 3 circuits', async () => {
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
    });
  });

  describe('generate_proof', () => {
    it('coinbase_kyc: full E2E proof generation', async () => {
      const result = await client.callTool({
        name: 'generate_proof',
        arguments: {
          circuit: 'coinbase_kyc',
          scope: 'e2e-test:npm-mcp-kyc',
        },
      });
      const text = (result.content as any[])[0]?.text;
      const data = JSON.parse(text);

      expect(result.isError).toBeFalsy();
      expect(data.proof).toBeTruthy();
      expect(data.proof.startsWith('0x')).toBe(true);
      expect(data.publicInputs).toBeTruthy();
      expect(data.paymentTxHash).toBeTruthy();
    }, 120_000);

    it('coinbase_country: full E2E proof generation', async () => {
      const result = await client.callTool({
        name: 'generate_proof',
        arguments: {
          circuit: 'coinbase_country',
          scope: 'e2e-test:npm-mcp-country',
          country_list: ['US', 'KR'],
          is_included: true,
        },
      });
      const text = (result.content as any[])[0]?.text;
      const data = JSON.parse(text);

      expect(result.isError).toBeFalsy();
      expect(data.proof).toBeTruthy();
    }, 120_000);

    it.skipIf(!OIDC_JWT)('oidc_domain: full E2E proof generation', async () => {
      const result = await client.callTool({
        name: 'generate_proof',
        arguments: {
          circuit: 'oidc_domain',
          scope: 'e2e-test:npm-mcp-oidc',
          jwt: OIDC_JWT,
        },
      });
      const text = (result.content as any[])[0]?.text;
      const data = JSON.parse(text);

      expect(result.isError).toBeFalsy();
      expect(data.proof).toBeTruthy();
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
