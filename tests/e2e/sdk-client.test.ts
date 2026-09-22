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
  extractNullifierFromPublicInputs,
  CIRCUITS,
  type ClientConfig,
  type ProofportSigner,
  type PaymentWallet,
} from '@zkproofport-ai/sdk';
import { planPayment, unfundedReason } from './payer.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';
const ATTESTATION_KEY = process.env.ATTESTATION_KEY;
/*
 * A DIFFERENT wallet from ATTESTATION_KEY.
 *
 * giwa_attestation is attested by our own attester on GIWA Sepolia, not by
 * Coinbase on Base, so the wallet that satisfies one satisfies neither the
 * other. Only one wallet is attested on GIWA today, and its key is the one
 * the circuit fixtures are generated from.
 */
const GIWA_KEY = process.env.GIWA_ATTESTATION_KEY;
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
if (!GIWA_KEY) console.warn('SKIP GIWA proofs: GIWA_ATTESTATION_KEY missing');

describe('SDK Client E2E — npm @zkproofport-ai/sdk', () => {
  let config: ClientConfig;
  let attestationSigner: ProofportSigner;
  let giwaSigner: ProofportSigner | undefined;
  let paymentWallet: PaymentWallet | undefined;
  let payOn: string | undefined;

  beforeAll(async () => {
    if (!ATTESTATION_KEY) throw new Error('ATTESTATION_KEY required in .env.test');
    if (!PAYER_KEY) throw new Error('E2E_PAYER_WALLET_KEY required in .env.test');

    config = createConfig({
      baseUrl: BASE_URL,
    });

    attestationSigner = fromPrivateKey(ATTESTATION_KEY);
    giwaSigner = GIWA_KEY ? fromPrivateKey(GIWA_KEY) : undefined;
    /*
     * A payment wallet, not a signer. `fromPrivateKey` makes an attestation
     * signer whose address is behind `getAddress()`; the payment path reads
     * `.address` and got undefined, which viem reported as an invalid address.
     * The chain comes from what the service offers — a test does not decide
     * which chains a deployment takes money on.
     */
    const plan = await planPayment(config, 'coinbase_kyc', PAYER_KEY);
    paymentWallet = plan.wallet;
    payOn = plan.payOn;

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
      expect(challenge.payment).toBeDefined();
      if (challenge.requiresPayment !== false) {
        expect(challenge.nonce).toBeTruthy();
        expect(challenge.payment.payTo).toBeTruthy();
      }
    });

    it('should return 402 challenge for oidc_domain', async () => {
      const challenge = await requestChallenge(config, 'oidc_domain');
      expect(challenge.payment).toBeDefined();
      if (challenge.requiresPayment !== false) {
        expect(challenge.nonce).toBeTruthy();
      }
    });
  });

  describe('generateProof', () => {
    it('coinbase_kyc: full E2E proof generation', async () => {
      const result = await generateProof(
        config,
        { attestation: attestationSigner, payment: paymentWallet },
        { circuit: 'coinbase_kyc', scope: 'e2e-test:npm-sdk-kyc', payOn },
      );

      expect(result.proof).toBeTruthy();
      expect(result.proof.startsWith('0x')).toBe(true);
      expect(result.publicInputs).toBeTruthy();
      // paymentTxHash only present when payment is required (not in free tier)
      if (result.paymentTxHash) expect(result.paymentTxHash).toMatch(/^0x/);
      expect(result.timing).toBeDefined();
      expect(result.verification).toBeDefined();
    }, 120_000);

    it.skipIf(!GIWA_KEY)('giwa_attestation: full E2E proof generation, no action', async () => {
      const result = await generateProof(
        config,
        { attestation: giwaSigner!, payment: paymentWallet },
        {
          circuit: 'giwa_attestation',
          scope: 'e2e-test:npm-sdk-giwa',
          payOn,
        },
      );

      expect(result.proof).toBeTruthy();
      expect(result.proof.startsWith('0x')).toBe(true);
      expect(result.publicInputs).toBeTruthy();
      /*
       * Six 32-byte public inputs -- signal_hash, domain_separator,
       * action_hash, signer_list_merkle_root, scope, nullifier -- as ONE
       * 0x-prefixed hex string of 192 field elements, each padded to 32 bytes.
       * The count is asserted through the string's length rather than an array
       * length, because the server returns a string and `'0x…'.length` would
       * otherwise have been compared against 192 and passed for no reason.
       */
      expect(result.publicInputs.startsWith('0x')).toBe(true);
      expect((result.publicInputs.length - 2) / 2).toBe(192 * 32);
      if (result.paymentTxHash) expect(result.paymentTxHash).toMatch(/^0x/);
    }, 180_000);

    it.skipIf(!GIWA_KEY)('giwa_attestation: full E2E proof generation, with an action', async () => {
      const result = await generateProof(
        config,
        { attestation: giwaSigner!, payment: paymentWallet },
        {
          circuit: 'giwa_attestation',
          scope: 'e2e-test:npm-sdk-giwa-action',
          payOn,
          action: {
            domain: {
              name: 'GIWA E2E',
              version: '1',
              // The chain the GIWA verifier is on. A wallet refuses typed data
              // whose domain names a chain it is not on.
              chainId: 91342,
              verifyingContract: '0x6646d970499BBeD728636823A5A7e551E811b414',
            },
            types: {
              Deposit: [
                { name: 'amount', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
              ],
            },
            primaryType: 'Deposit',
            message: { amount: '1000000', nonce: '1' },
          },
        },
      );

      expect(result.proof).toBeTruthy();
      expect((result.publicInputs.length - 2) / 2).toBe(192 * 32);
    }, 180_000);

    it.skipIf(!GIWA_KEY)('giwa_attestation: the same wallet and scope give the same nullifier in both modes', async () => {
      // The property the circuit change exists for. If the nullifier still
      // came from signal_hash these two would differ, because signal_hash is
      // zero in action mode -- one wallet, two identities, one scope.
      const scope = 'e2e-test:npm-sdk-giwa-nullifier';
      const plain = await generateProof(
        config,
        { attestation: giwaSigner!, payment: paymentWallet },
        { circuit: 'giwa_attestation', scope, payOn },
      );
      const bound = await generateProof(
        config,
        { attestation: giwaSigner!, payment: paymentWallet },
        {
          circuit: 'giwa_attestation',
          scope,
          payOn,
          action: {
            domain: { name: 'GIWA E2E', version: '1', chainId: 91342, verifyingContract: '0x6646d970499BBeD728636823A5A7e551E811b414' },
            types: { Deposit: [{ name: 'amount', type: 'uint256' }] },
            primaryType: 'Deposit',
            message: { amount: '1' },
          },
        },
      );
      // ProofResult carries no nullifier field, so it is read from the public
      // inputs with the SDK's own per-circuit layout -- the same reader a
      // consumer would use.
      expect(extractNullifierFromPublicInputs(bound.publicInputs, 'giwa_attestation')).toBe(
        extractNullifierFromPublicInputs(plain.publicInputs, 'giwa_attestation'),
      );
      expect(extractNullifierFromPublicInputs(plain.publicInputs, 'giwa_attestation')).toMatch(/^0x[0-9a-f]{64}$/i);
    }, 300_000);

    it('coinbase_country: full E2E proof generation', async () => {
      const result = await generateProof(
        config,
        { attestation: attestationSigner, payment: paymentWallet },
        {
          circuit: 'coinbase_country',
          scope: 'e2e-test:npm-sdk-country',
          payOn,
          countryList: ['US', 'KR'],
          isIncluded: true,
        },
      );

      expect(result.proof).toBeTruthy();
      expect(result.publicInputs).toBeTruthy();
      if (result.paymentTxHash) expect(result.paymentTxHash).toMatch(/^0x/);
    }, 120_000);

    it.skipIf(!OIDC_JWT)('oidc_domain: full E2E proof generation', async () => {
      const result = await generateProof(
        config,
        { attestation: attestationSigner, payment: paymentWallet },
        {
          circuit: 'oidc_domain',
          scope: 'e2e-test:npm-sdk-oidc',
          payOn,
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
        { attestation: attestationSigner, payment: paymentWallet },
        { circuit: 'coinbase_kyc', scope: 'e2e-test:npm-sdk-verify', payOn },
      );

      const verifyResult = await verifyProof(proofResult);
      expect(verifyResult.valid).toBe(true);
    }, 180_000);
  });
});
