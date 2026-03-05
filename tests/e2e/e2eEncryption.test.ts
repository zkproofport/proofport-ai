/**
 * E2E Tests for TEE Encryption Flow
 *
 * Tests the 402 challenge → encrypt → submit encrypted proof flow
 * against a real Docker container.
 *
 * Prerequisites:
 *   cd proofport-ai && docker compose up --build -d
 *   Wait for healthy: curl http://localhost:4002/health
 *
 * Run: npx vitest run tests/e2e/e2eEncryption.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  encryptForTee,
  computeKeyId,
} from '../../src/tee/teeKeyExchange';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';

async function jsonPost(path: string, body: unknown, headers?: Record<string, string>) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, headers: res.headers, text, json };
}

describe('E2E Encryption Flow', () => {
  let serverAvailable = false;

  beforeAll(async () => {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      serverAvailable = res.ok;
    } catch {
      serverAvailable = false;
    }
  });

  describe('402 challenge with TEE public key', () => {
    it('should return 402 with standard fields when posting circuit only', async () => {
      if (!serverAvailable) return; // skip if container not running

      const res = await jsonPost('/api/v1/prove', { circuit: 'coinbase_kyc' });

      expect(res.status).toBe(402);
      expect(res.json.error).toBe('PAYMENT_REQUIRED');
      expect(res.json.nonce).toBeTruthy();
      expect(typeof res.json.nonce).toBe('string');
      expect(res.json.payment).toBeTruthy();
      expect(res.json.payment.scheme).toBe('exact');
      expect(res.json.payment.payTo).toBeTruthy();
      expect(res.json.payment.maxAmountRequired).toBeTruthy();
    });

    it('should include teePublicKey field in 402 response', async () => {
      if (!serverAvailable) return;

      const res = await jsonPost('/api/v1/prove', { circuit: 'coinbase_kyc' });

      expect(res.status).toBe(402);
      // teePublicKey is present as a field (may be null if TEE disabled)
      expect('teePublicKey' in res.json).toBe(true);
    });

    it('should have valid teePublicKey structure when TEE is enabled', async () => {
      if (!serverAvailable) return;

      const res = await jsonPost('/api/v1/prove', { circuit: 'coinbase_kyc' });

      if (res.json.teePublicKey) {
        // publicKey: 32 bytes = 64 hex chars
        expect(res.json.teePublicKey.publicKey).toMatch(/^[0-9a-f]{64}$/);
        // keyId: 16 hex chars
        expect(res.json.teePublicKey.keyId).toMatch(/^[0-9a-f]{16}$/);
        // keyId should match computed keyId
        expect(res.json.teePublicKey.keyId).toBe(computeKeyId(res.json.teePublicKey.publicKey));
        // attestationDocument: null or base64 string
        if (res.json.teePublicKey.attestationDocument) {
          expect(typeof res.json.teePublicKey.attestationDocument).toBe('string');
        }
      }
    });

    it('should return same TEE key across multiple 402 requests', async () => {
      if (!serverAvailable) return;

      const res1 = await jsonPost('/api/v1/prove', { circuit: 'coinbase_kyc' });
      const res2 = await jsonPost('/api/v1/prove', { circuit: 'coinbase_country' });

      if (res1.json.teePublicKey && res2.json.teePublicKey) {
        expect(res1.json.teePublicKey.publicKey).toBe(res2.json.teePublicKey.publicKey);
        expect(res1.json.teePublicKey.keyId).toBe(res2.json.teePublicKey.keyId);
      }
    });

    it('should return different nonces per request', async () => {
      if (!serverAvailable) return;

      const res1 = await jsonPost('/api/v1/prove', { circuit: 'coinbase_kyc' });
      const res2 = await jsonPost('/api/v1/prove', { circuit: 'coinbase_kyc' });

      expect(res1.json.nonce).not.toBe(res2.json.nonce);
    });
  });

  describe('encrypted payload submission', () => {
    it('should reject encrypted payload without payment headers', async () => {
      if (!serverAvailable) return;

      // First get the TEE key from 402
      const challengeRes = await jsonPost('/api/v1/prove', { circuit: 'coinbase_kyc' });
      if (!challengeRes.json.teePublicKey) return; // skip if no TEE

      // Encrypt a dummy payload
      const encryptedPayload = encryptForTee(
        JSON.stringify({ circuitId: 'coinbase_attestation', proverToml: 'signal_hash = [0xab]' }),
        challengeRes.json.teePublicKey.publicKey,
      );

      // Submit without payment — should get 402, not 400 "missing inputs"
      const res = await jsonPost('/api/v1/prove', {
        circuit: 'coinbase_kyc',
        encrypted_payload: encryptedPayload,
      });

      // Without payment headers, server returns 402 challenge (not 400 "missing inputs")
      // This proves the encrypted_payload doesn't trigger the "missing inputs" check
      expect(res.status).toBe(402);
    });

    it('should reject encrypted payload with invalid payment', async () => {
      if (!serverAvailable) return;

      const challengeRes = await jsonPost('/api/v1/prove', { circuit: 'coinbase_kyc' });
      if (!challengeRes.json.teePublicKey) return;

      const encryptedPayload = encryptForTee(
        JSON.stringify({ circuitId: 'coinbase_attestation', proverToml: 'signal_hash = [0xab]' }),
        challengeRes.json.teePublicKey.publicKey,
      );

      // Submit with fake payment headers
      const res = await jsonPost('/api/v1/prove', {
        circuit: 'coinbase_kyc',
        encrypted_payload: encryptedPayload,
      }, {
        'X-Payment-TX': '0x' + 'ab'.repeat(32),
        'X-Payment-Nonce': challengeRes.json.nonce,
      });

      // Should fail on payment verification, NOT on "missing inputs"
      // Possible errors: PAYMENT_INVALID, or payment verification error
      expect(res.status).not.toBe(400);
      if (res.json?.error) {
        expect(res.json.error).not.toBe('INVALID_REQUEST');
      }
    });

    it('should reject requests with no circuit', async () => {
      if (!serverAvailable) return;

      const res = await jsonPost('/api/v1/prove', { encrypted_payload: { ephemeralPublicKey: 'aa', iv: 'bb', ciphertext: 'cc', authTag: 'dd', keyId: 'ee' } });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe('INVALID_REQUEST');
      expect(res.json.message).toContain('circuit');
    });
  });

  describe('removed endpoint', () => {
    it('GET /api/v1/tee/public-key should return 404 (removed)', async () => {
      if (!serverAvailable) return;

      const res = await fetch(`${BASE_URL}/api/v1/tee/public-key`);
      // The endpoint was removed — should be 404
      expect(res.status).toBe(404);
    });
  });
});
