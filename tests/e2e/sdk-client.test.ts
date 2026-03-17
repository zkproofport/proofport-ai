/**
 * SDK Client E2E Tests — npm Package
 *
 * Tests the published @zkproofport-ai/sdk npm package against a real backend.
 * Verifies that the npm-published SDK correctly integrates with the backend
 * for all supported circuits.
 *
 * Prerequisites:
 *   - `npm install @zkproofport-ai/sdk` in proofport-ai root
 *   - Backend running at E2E_BASE_URL (default: http://localhost:4002)
 *   - .env.test with ATTESTATION_KEY, E2E_PAYER_WALLET_KEY
 *   - For OIDC: E2E_OIDC_JWT
 *
 * Run: npx vitest run --project e2e tests/e2e/sdk-client.test.ts
 */

import { execSync } from 'child_process';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createConfig,
  generateProof,
  fromPrivateKey,
  verifyProof,
  requestChallenge,
  CIRCUITS,
  type ClientConfig,
  type ProofportSigner,
} from '@zkproofport-ai/sdk';

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

describe('SDK Client E2E — npm @zkproofport-ai/sdk', () => {
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

  describe('CIRCUITS constant', () => {
    it('should export all 3 circuits', () => {
      expect(CIRCUITS.coinbase_attestation).toBeDefined();
      expect(CIRCUITS.coinbase_country_attestation).toBeDefined();
      expect(CIRCUITS.oidc_domain_attestation).toBeDefined();
      expect(CIRCUITS.oidc_domain_attestation.inputType).toBe('oidc');
    });
  });

  describe('requestChallenge', () => {
    it('should return 402 challenge for coinbase_kyc', async () => {
      const challenge = await requestChallenge(config, 'coinbase_kyc');
      expect(challenge.nonce).toBeTruthy();
      expect(challenge.payment).toBeDefined();
      expect(challenge.payment.payTo).toBeTruthy();
    });

    it('should return 402 challenge for oidc_domain', async () => {
      const challenge = await requestChallenge(config, 'oidc_domain');
      expect(challenge.nonce).toBeTruthy();
      expect(challenge.payment).toBeDefined();
    });
  });

  describe('generateProof', () => {
    it('coinbase_kyc: full E2E proof generation', async () => {
      const result = await generateProof(
        config,
        { attestation: attestationSigner, payment: paymentSigner },
        { circuit: 'coinbase_kyc', scope: 'e2e-test:npm-sdk-kyc' },
      );

      expect(result.proof).toBeTruthy();
      expect(result.proof.startsWith('0x')).toBe(true);
      expect(result.publicInputs).toBeTruthy();
      expect(result.paymentTxHash).toBeTruthy();
      expect(result.timing).toBeDefined();
      expect(result.verification).toBeDefined();
    }, 120_000);

    it('coinbase_country: full E2E proof generation', async () => {
      const result = await generateProof(
        config,
        { attestation: attestationSigner, payment: paymentSigner },
        {
          circuit: 'coinbase_country',
          scope: 'e2e-test:npm-sdk-country',
          countryList: ['US', 'KR'],
          isIncluded: true,
        },
      );

      expect(result.proof).toBeTruthy();
      expect(result.publicInputs).toBeTruthy();
      expect(result.paymentTxHash).toBeTruthy();
    }, 120_000);

    it.skipIf(!OIDC_JWT)('oidc_domain: full E2E proof generation', async () => {
      const result = await generateProof(
        config,
        { attestation: attestationSigner, payment: paymentSigner },
        {
          circuit: 'oidc_domain',
          scope: 'e2e-test:npm-sdk-oidc',
          jwt: OIDC_JWT,
        },
      );

      expect(result.proof).toBeTruthy();
      expect(result.proof.startsWith('0x')).toBe(true);
      expect(result.publicInputs).toBeTruthy();
    }, 120_000);
  });

  describe('verifyProof', () => {
    it('should verify a generated proof on-chain', async () => {
      const proofResult = await generateProof(
        config,
        { attestation: attestationSigner, payment: paymentSigner },
        { circuit: 'coinbase_kyc', scope: 'e2e-test:npm-sdk-verify' },
      );

      const verifyResult = await verifyProof(proofResult);
      expect(verifyResult.valid).toBe(true);
    }, 180_000);
  });
});
