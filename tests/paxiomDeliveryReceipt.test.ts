import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { generateReceiptKeyPair, verifyReceipt } from '@paxiom/receipts';
import { createApp } from '../src/index.js';
import type { Config } from '../src/config/index.js';

vi.mock('../src/tracing.js', () => ({}));
vi.mock('../src/redis/client.js', () => ({ createRedisClient: vi.fn(() => ({})) }));
vi.mock('../src/identity/autoRegister.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/identity/autoRegister.js')>()),
  ensureAgentRegistered: vi.fn(),
}));
vi.mock('../src/proof/proofRoutes.js', async () => {
  const { Router } = await import('express');
  return {
    createProofRoutes: () => {
      const router = Router();
      router.post('/prove', (req, res) => {
        if (!req.headers['payment-signature'] && !req.headers['x-payment-tx']) {
          res.status(402).json({ error: 'PAYMENT_REQUIRED' });
          return;
        }
        res.status(200).json({
          circuit: req.body?.circuit ?? 'coinbase_attestation',
          proof: '0xdeadbeef',
          publicInputs: '0x01',
        });
      });
      return router;
    },
  };
});

const baseConfig = {
  paymentMode: 'testnet',
  paymentNetworks: 'base-sepolia',
  paymentProofPrice: '$0.10',
  paymentPayTo: '0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c',
  teeMode: 'disabled',
  teeAttestationEnabled: false,
  a2aBaseUrl: 'https://proof.example.com',
  websiteUrl: 'https://example.com',
  chainRpcUrl: 'https://sepolia.base.org',
  erc8004IdentityAddress: '',
  proverPrivateKey: '0x' + '11'.repeat(32),
  agentVersion: '1.0.0',
  redisUrl: 'redis://example.invalid',
  circuitsDir: 'circuits',
  bbPath: 'bb',
} as Config;

describe('opt-in Paxiom Ed25519 delivery receipts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stays completely inert when paxiomPrivateKeyPem is unset', async () => {
    const { app } = createApp(baseConfig);

    const keysRes = await request(app).get('/.well-known/x402-keys.json');
    expect(keysRes.status).toBe(404);

    const proveRes = await request(app)
      .post('/api/v1/prove')
      .set('PAYMENT-SIGNATURE', Buffer.from(JSON.stringify({ x402Version: 2 })).toString('base64'))
      .send({ circuit: 'coinbase_attestation' });

    expect(proveRes.status).toBe(200);
    expect(proveRes.headers['payment-receipt']).toBeUndefined();
    expect(proveRes.headers['x-paxiom-receipt']).toBeUndefined();
  });

  it('rejects non-Ed25519 private keys at startup', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    expect(() =>
      createApp({
        ...baseConfig,
        paxiomPrivateKeyPem: rsaPem,
      }),
    ).toThrow(/Ed25519/);
  });

  it('publishes /.well-known/x402-keys.json and signs 2xx proof responses with verifiable receipts', async () => {
    const keyPair = generateReceiptKeyPair('proofport-test-01');
    const { app } = createApp({
      ...baseConfig,
      paxiomPrivateKeyPem: keyPair.privateKeyPem,
      paxiomKeyId: keyPair.keyId,
    });

    const keysRes = await request(app).get('/.well-known/x402-keys.json');
    expect(keysRes.status).toBe(200);
    expect(keysRes.body).toEqual({
      version: 'x402-keys.v1',
      issuer: 'https://proof.example.com',
      payTo: baseConfig.paymentPayTo,
      keys: [
        {
          keyId: 'proofport-test-01',
          algorithm: 'ed25519',
          publicKey: keyPair.publicKey,
        },
      ],
    });

    // 402 challenges must never receive delivery receipts
    const challengeRes = await request(app)
      .post('/api/v1/prove')
      .send({ circuit: 'coinbase_attestation' });
    expect(challengeRes.status).toBe(402);
    expect(challengeRes.headers['payment-receipt']).toBeUndefined();

    // Paid 200 responses receive matching Payment-Receipt and X-Paxiom-Receipt headers
    const paymentPayload = {
      x402Version: 2,
      accepted: {
        scheme: 'exact',
        network: 'eip155:84532',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amount: '100000',
        payTo: baseConfig.paymentPayTo,
      },
      payload: {
        authorization: {
          from: '0x1111111111111111111111111111111111111111',
          to: baseConfig.paymentPayTo,
          value: '100000',
        },
      },
    };
    const proveRes = await request(app)
      .post('/api/v1/prove')
      .set('PAYMENT-SIGNATURE', Buffer.from(JSON.stringify(paymentPayload)).toString('base64'))
      .send({ circuit: 'coinbase_attestation' });

    expect(proveRes.status).toBe(200);
    const paymentReceiptHdr = proveRes.headers['payment-receipt'];
    const legacyReceiptHdr = proveRes.headers['x-paxiom-receipt'];
    expect(typeof paymentReceiptHdr).toBe('string');
    expect(paymentReceiptHdr).toBe(legacyReceiptHdr);

    const decoded = JSON.parse(Buffer.from(paymentReceiptHdr, 'base64url').toString('utf8'));
    const verified = verifyReceipt(decoded, {
      output: proveRes.body,
      expectedIssuerPublicKeys: [keyPair.publicKey],
      expectedPayTo: baseConfig.paymentPayTo,
    });
    expect(verified.valid).toBe(true);
    expect(verified.trustState).toBe('verified');

    const tampered = verifyReceipt(decoded, {
      output: { ...proveRes.body, proof: '0xcafebabe' },
      expectedIssuerPublicKeys: [keyPair.publicKey],
      expectedPayTo: baseConfig.paymentPayTo,
    });
    expect(tampered.valid).toBe(false);
    expect(tampered.trustState).toBe('output_hash_mismatch');
  });

  it('marks direct X-Payment-TX receipts as settlement_claimed_not_checked for offline verifiers', async () => {
    const keyPair = generateReceiptKeyPair('proofport-test-02');
    const { app } = createApp({
      ...baseConfig,
      paxiomPrivateKeyPem: keyPair.privateKeyPem,
      paxiomKeyId: keyPair.keyId,
    });

    const txHash = '0x' + 'ab'.repeat(32);
    const proveRes = await request(app)
      .post('/api/v1/prove')
      .set('X-Payment-TX', txHash)
      .send({ circuit: 'coinbase_attestation' });

    expect(proveRes.status).toBe(200);
    const decoded = JSON.parse(Buffer.from(proveRes.headers['payment-receipt'], 'base64url').toString('utf8'));
    expect(decoded.payload.payment.settlement.transactionHash).toBe(txHash);

    const verdict = verifyReceipt(decoded, {
      output: proveRes.body,
      expectedIssuerPublicKeys: [keyPair.publicKey],
      expectedPayTo: baseConfig.paymentPayTo,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.trustState).toBe('settlement_claimed_not_checked');
  });
});
