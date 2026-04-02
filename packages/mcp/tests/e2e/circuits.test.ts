/**
 * MCP E2E Tests — Local Source
 *
 * Tests all MCP tools against a real backend using the local MCP server source.
 * The MCP server is spawned as a stdio subprocess and connected via MCP SDK client.
 *
 * Prerequisites:
 *   - Backend running at E2E_BASE_URL (default: http://localhost:4002)
 *   - .env.test with ATTESTATION_KEY, E2E_PAYER_WALLET_KEY
 *   - For OIDC: E2E_OIDC_JWT
 *
 * Run: npx vitest run tests/e2e/circuits.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Load .env.test
const envPath = resolve(__dirname, '../../../../.env.test');
try {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {}

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';
const ATTESTATION_KEY = process.env.ATTESTATION_KEY;
const PAYER_KEY = process.env.E2E_PAYER_WALLET_KEY;

// Auto-generate OIDC JWT via gcloud CLI if not provided
function getOidcJwt(): string | undefined {
  if (process.env.E2E_OIDC_JWT) return process.env.E2E_OIDC_JWT;
  try {
    return execSync('gcloud auth print-identity-token', { encoding: 'utf-8' }).trim();
  } catch {
    return undefined;
  }
}
const OIDC_JWT = getOidcJwt();

describe('MCP E2E — All Circuits (local source)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    if (!ATTESTATION_KEY) throw new Error('ATTESTATION_KEY required in .env.test');
    if (!PAYER_KEY) throw new Error('E2E_PAYER_WALLET_KEY required in .env.test');

    // Health check
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.ok).toBe(true);

    // Spawn MCP server using local tsx
    transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', resolve(__dirname, '../../src/index.ts')],
      env: {
        ...process.env,
        PROOFPORT_URL: BASE_URL,
        ATTESTATION_KEY: ATTESTATION_KEY!,
        PAYMENT_KEY: PAYER_KEY!,
      },
    });

    client = new Client(
      { name: 'mcp-e2e-test', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try { await client?.close(); } catch {}
  });

  it('get_supported_circuits: should list all 3 circuits', async () => {
    const result = await client.callTool({ name: 'get_supported_circuits', arguments: {} });
    const text = (result.content as any[])[0]?.text;
    const data = JSON.parse(text);

    expect(data.circuits).toBeDefined();
    expect(data.circuits.coinbase_attestation).toBeDefined();
    expect(data.circuits.coinbase_country_attestation).toBeDefined();
    expect(data.circuits.oidc_domain_attestation).toBeDefined();
  });

  it('generate_proof coinbase_kyc: should generate proof end-to-end', async () => {
    const result = await client.callTool(
      { name: 'generate_proof', arguments: { circuit: 'coinbase_kyc', scope: 'e2e-test:mcp-coinbase-kyc' } },
      undefined,
      { timeout: 120_000 },
    );
    const text = (result.content as any[])[0]?.text;
    const data = JSON.parse(text);

    expect(result.isError).toBeFalsy();
    expect(data.proof).toBeTruthy();
    expect(data.proof.startsWith('0x')).toBe(true);
    expect(data.publicInputs).toBeTruthy();
    expect(data.paymentTxHash).toBeDefined();
  }, 120_000);

  it('generate_proof coinbase_country: should generate proof end-to-end', async () => {
    const result = await client.callTool(
      {
        name: 'generate_proof',
        arguments: {
          circuit: 'coinbase_country',
          scope: 'e2e-test:mcp-coinbase-country',
          country_list: ['US', 'KR'],
          is_included: true,
        },
      },
      undefined,
      { timeout: 120_000 },
    );
    const text = (result.content as any[])[0]?.text;
    const data = JSON.parse(text);

    expect(result.isError).toBeFalsy();
    expect(data.proof).toBeTruthy();
  }, 120_000);

  it.skipIf(!OIDC_JWT)('generate_proof oidc_domain: should generate proof end-to-end', async () => {
    const result = await client.callTool(
      {
        name: 'generate_proof',
        arguments: {
          circuit: 'oidc_domain',
          scope: 'e2e-test:mcp-oidc-domain',
          jwt: OIDC_JWT,
        },
      },
      undefined,
      { timeout: 120_000 },
    );
    const text = (result.content as any[])[0]?.text;
    const data = JSON.parse(text);

    expect(result.isError).toBeFalsy();
    expect(data.proof).toBeTruthy();
    expect(data.proof.startsWith('0x')).toBe(true);
  }, 120_000);

  it('verify_proof coinbase_kyc: should verify a proof on-chain', async () => {
    // First generate a proof (needs extended timeout for proof generation)
    const genResult = await client.callTool(
      { name: 'generate_proof', arguments: { circuit: 'coinbase_kyc', scope: 'e2e-test:mcp-verify' } },
      undefined,
      { timeout: 120_000 },
    );
    const genText = (genResult.content as any[])[0]?.text;
    const genData = JSON.parse(genText);

    // Then verify it — pass the full result object directly
    const verifyResult = await client.callTool({
      name: 'verify_proof',
      arguments: { result: genData },
    });
    const verifyText = (verifyResult.content as any[])[0]?.text;
    const verifyData = JSON.parse(verifyText);

    expect(verifyResult.isError).toBeFalsy();
    expect(verifyData.valid).toBe(true);
  }, 180_000);

  it.skipIf(!OIDC_JWT)('verify_proof oidc_domain: should verify a proof on-chain', async () => {
    // First generate an OIDC proof (needs extended timeout)
    const genResult = await client.callTool(
      {
        name: 'generate_proof',
        arguments: {
          circuit: 'oidc_domain',
          scope: 'e2e-test:mcp-oidc-verify',
          jwt: OIDC_JWT,
        },
      },
      undefined,
      { timeout: 120_000 },
    );
    const genText = (genResult.content as any[])[0]?.text;
    const genData = JSON.parse(genText);

    // Then verify it — pass the full result object directly
    const verifyResult = await client.callTool({
      name: 'verify_proof',
      arguments: { result: genData },
    });
    const verifyText = (verifyResult.content as any[])[0]?.text;
    const verifyData = JSON.parse(verifyText);

    expect(verifyResult.isError).toBeFalsy();
    expect(verifyData.valid).toBe(true);
  }, 180_000);
});
