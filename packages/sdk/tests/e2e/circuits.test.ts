/**
 * SDK E2E Tests — Local Source
 *
 * Tests all 3 circuits against a real backend using the local SDK source.
 * Used for pre-deployment validation (before npm publish).
 *
 * Prerequisites:
 *   - Backend running at E2E_BASE_URL (default: http://localhost:4002)
 *   - .env.test with ATTESTATION_KEY, E2E_PAYER_WALLET_KEY
 *   - For OIDC: E2E_OIDC_JWT (e.g., `gcloud auth print-identity-token`)
 *
 * Run: npx vitest run tests/e2e/circuits.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import {
  createConfig,
  generateProof,
  verifyProof,
  fromPrivateKey,
  extractScopeFromPublicInputs,
  extractNullifierFromPublicInputs,
  extractDomainFromPublicInputs,
  type ClientConfig,
  type ProofportSigner,
} from '../../src/index.js';
import { ethers } from 'ethers';

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
// Check if JWT has hd claim (Google Workspace) — personal Gmail won't work for oidc_domain
const isWorkspaceJwt = (() => {
  if (!OIDC_JWT) return false;
  try {
    const payload = JSON.parse(Buffer.from(OIDC_JWT.split('.')[1], 'base64').toString());
    return !!payload.hd;
  } catch { return false; }
})();

describe('SDK E2E — All Circuits (local source)', () => {
  let config: ClientConfig;
  let attestationSigner: ProofportSigner;
  let paymentSigner: ProofportSigner;

  beforeAll(async () => {
    if (!ATTESTATION_KEY) throw new Error('ATTESTATION_KEY required in .env.test');
    if (!PAYER_KEY) throw new Error('E2E_PAYER_WALLET_KEY required in .env.test');

    config = createConfig({
      baseUrl: BASE_URL,
    });

    attestationSigner = fromPrivateKey(ATTESTATION_KEY);
    paymentSigner = fromPrivateKey(PAYER_KEY);

    // Health check
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.ok).toBe(true);
  });

  it('coinbase_kyc: should generate and verify proof end-to-end', async () => {
    const result = await generateProof(
      config,
      { attestation: attestationSigner, payment: paymentSigner },
      { circuit: 'coinbase_kyc', scope: 'e2e-test:sdk-coinbase-kyc' },
    );

    expect(result.proof).toBeTruthy();
    expect(result.proof.startsWith('0x')).toBe(true);
    expect(result.publicInputs).toBeTruthy();
    expect(result.paymentTxHash).toBeDefined();
    expect(result.timing).toBeDefined();

    // Extract scope and nullifier
    const scope = extractScopeFromPublicInputs(result.publicInputs);
    const expectedScope = ethers.keccak256(ethers.toUtf8Bytes('e2e-test:sdk-coinbase-kyc'));
    expect(scope).toBe(expectedScope);
    const nullifier = extractNullifierFromPublicInputs(result.publicInputs);
    expect(nullifier).toBeTruthy();
    expect(nullifier!.startsWith('0x')).toBe(true);

    // Verify on-chain
    const verified = await verifyProof(result);
    expect(verified.valid).toBe(true);
  }, 180_000);

  it('coinbase_country: should generate and verify proof end-to-end', async () => {
    const result = await generateProof(
      config,
      { attestation: attestationSigner, payment: paymentSigner },
      {
        circuit: 'coinbase_country',
        scope: 'e2e-test:sdk-coinbase-country',
        countryList: ['US', 'KR'],
        isIncluded: true,
      },
    );

    expect(result.proof).toBeTruthy();
    expect(result.proof.startsWith('0x')).toBe(true);
    expect(result.publicInputs).toBeTruthy();
    expect(result.paymentTxHash).toBeDefined();

    // Extract scope and nullifier
    const scope = extractScopeFromPublicInputs(result.publicInputs);
    const expectedScope = ethers.keccak256(ethers.toUtf8Bytes('e2e-test:sdk-coinbase-country'));
    expect(scope).toBe(expectedScope);
    const nullifier = extractNullifierFromPublicInputs(result.publicInputs);
    expect(nullifier).toBeTruthy();

    // Verify on-chain
    const verified = await verifyProof(result);
    expect(verified.valid).toBe(true);
  }, 180_000);

  it.skipIf(!OIDC_JWT)('oidc_domain: should generate and verify proof end-to-end', async () => {
    const result = await generateProof(
      config,
      { attestation: attestationSigner, payment: paymentSigner },
      {
        circuit: 'oidc_domain',
        scope: 'e2e-test:sdk-oidc-domain',
        jwt: OIDC_JWT,
        // No provider = personal Gmail OK (no hd claim required)
        // Use provider: 'google' for Workspace, 'microsoft' for MS365
      },
    );

    expect(result.proof).toBeTruthy();
    expect(result.proof.startsWith('0x')).toBe(true);
    expect(result.publicInputs).toBeTruthy();
    expect(result.paymentTxHash).toBeDefined();

    // Extract scope, nullifier, and domain
    const scope = extractScopeFromPublicInputs(result.publicInputs);
    const expectedScope = ethers.keccak256(ethers.toUtf8Bytes('e2e-test:sdk-oidc-domain'));
    expect(scope).toBe(expectedScope);
    const nullifier = extractNullifierFromPublicInputs(result.publicInputs);
    expect(nullifier).toBeTruthy();
    const domain = extractDomainFromPublicInputs(result.publicInputs);
    expect(domain).toBeTruthy();
    expect(domain!.includes('.')).toBe(true); // valid domain format
    console.log(`[E2E] OIDC domain extracted: ${domain}`);

    // Verify on-chain
    const verified = await verifyProof(result);
    expect(verified.valid).toBe(true);
  }, 180_000);
});
