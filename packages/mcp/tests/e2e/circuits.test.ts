/**
 * MCP E2E Tests — Local Source
 *
 * Tests all MCP tools against a real backend using the local MCP server source.
 * The MCP server is spawned as a stdio subprocess and connected via MCP SDK client.
 *
 * Prerequisites:
 *   - Backend running at E2E_BASE_URL (default: http://localhost:4002)
 *   - .env.test with ATTESTATION_KEY
 *   - For OIDC: E2E_OIDC_JWT (or a usable `gcloud auth print-identity-token`)
 *
 * With no backend reachable the whole suite is skipped at collection time —
 * see the probe below.
 *
 * Run: npx vitest run --project e2e
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

// Auto-generate OIDC JWT via gcloud CLI if not provided.
// stderr is piped, not inherited: an unauthenticated gcloud otherwise dumps its
// reauth instructions into the test output on every run.
function getOidcJwt(): string | undefined {
  if (process.env.E2E_OIDC_JWT) return process.env.E2E_OIDC_JWT;
  try {
    return execSync('gcloud auth print-identity-token', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}
const OIDC_JWT = getOidcJwt();

/**
 * Probe the backend once, at collection time.
 *
 * This used to live in `beforeAll` as `expect(res.ok).toBe(true)`. A throwing
 * beforeAll marks every test in the suite as skipped but reports the FILE as
 * failed, so a machine with no backend (or with E2E_BASE_URL pointing at the
 * paused staging host) could never get a green run. Deciding before the suite
 * is declared lets vitest skip it outright.
 */
async function backendReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const SKIP_REASON = !ATTESTATION_KEY
  ? 'ATTESTATION_KEY is not set (see .env.test)'
  : (await backendReachable(BASE_URL))
    ? ''
    : `no backend answering GET ${BASE_URL}/health`;

if (SKIP_REASON) {
  console.warn(`[mcp e2e] skipping MCP E2E suite: ${SKIP_REASON}`);
}

describe.skipIf(SKIP_REASON !== '')('MCP E2E — All Circuits (local source)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    // Spawn MCP server using local tsx
    transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', resolve(__dirname, '../../src/index.ts')],
      env: {
        ...process.env,
        PROOFPORT_URL: BASE_URL,
        ATTESTATION_KEY: ATTESTATION_KEY!,
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
    // No paymentTxHash assertion: payment was removed from the SDK flow in
    // ee1c09d and ProofResult no longer carries one.
    expect(data.verification).toBeTruthy();
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
