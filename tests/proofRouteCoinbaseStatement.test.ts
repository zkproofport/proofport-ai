/**
 * POST /api/v1/prove for coinbase_attestation v2: the server reads the
 * attestation on chain and signs the revocation statement BEFORE it settles
 * any payment, refuses for free, and hands the statement to the prover.
 *
 * Matrix rows covered here (the statement module's own rows are in
 * coinbaseStatement.test.ts):
 *   contract   reader + signer are invoked for coinbase_attestation, never for other circuits
 *   order      statement before settlement; a refusal settles nothing
 *   hostile    malformed / oversize / non-hex fields refused with 400 before any read
 *   empty      missing fields; routes built without a signer answer 500, never prove
 *   authz      revoked / missing attestation -> 403, v1 nullifier -> 400
 *   E2E-encrypted payload refused for coinbase_attestation
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

const calls = vi.hoisted(() => [] as string[]);
const prove = vi.hoisted(() => vi.fn(async () => ({ proof: '0x11', publicInputs: '0x22', proofWithInputs: '0x1122' })));
vi.mock('../src/prover/bbProver.js', () => ({ BbProver: class { prove = prove; } }));
const settle = vi.hoisted(() => vi.fn(async () => { calls.push('settle'); return { txHash: '0x' + 'ab'.repeat(32), via: 'test' }; }));
vi.mock('../src/payment/settle.js', () => ({ settlePayment: settle }));
const verifyPayment = vi.hoisted(() => vi.fn(async () => ({ valid: true })));
vi.mock('../src/proof/paymentVerifier.js', () => ({ verifyPaymentOnChain: verifyPayment }));

import { createProofRoutes } from '../src/proof/proofRoutes.js';
import { computeWalletNullifier } from '../src/input/inputBuilder.js';
import { COINBASE_KYC_SCHEMA, type AttestationReader, type StatementSigner } from '../src/input/coinbaseStatement.js';
import { COINBASE_ATTESTER_CONTRACT } from '../src/config/contracts.js';
import type { Config } from '../src/config/index.js';
import { p256 as nobleP256 } from '@noble/curves/p256';
import { createPublicKey } from 'node:crypto';

const WALLET = '0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739';
const UID = '0x' + '5a'.repeat(32);
const SCOPE = ethers.keccak256(ethers.toUtf8Bytes('proofport'));

const priv = nobleP256.utils.randomPrivateKey();
const pub = nobleP256.getPublicKey(priv, false);
const PEM = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(pub.slice(1, 33)).toString('base64url'), y: Buffer.from(pub.slice(33)).toString('base64url') }, format: 'jwk' })
  .export({ format: 'pem', type: 'spki' }).toString();

function deps(revocationTime = 0n) {
  const reader: AttestationReader & { latestUid: ReturnType<typeof vi.fn>; onChain: ReturnType<typeof vi.fn> } = {
    latestUid: vi.fn(async () => { calls.push('read'); return UID; }),
    onChain: vi.fn(async (uid: string) => ({
      uid, schema: COINBASE_KYC_SCHEMA, recipient: WALLET, attester: COINBASE_ATTESTER_CONTRACT, revocationTime, expirationTime: 0n,
    })),
  };
  const signer: StatementSigner & { signDigest: ReturnType<typeof vi.fn> } = {
    signDigest: vi.fn(async (d: Uint8Array) => { calls.push('sign'); return nobleP256.sign(d, priv).toDERRawBytes(); }),
    publicKeyPem: async () => PEM,
  };
  return { reader, signer };
}

const baseConfig = {
  paymentMode: 'disabled', paymentNetworks: 'base-sepolia', paymentProofPrice: '$0.10', paymentPayTo: '0x' + '11'.repeat(20),
  teeMode: 'local', chainRpcUrl: 'https://sepolia.base.org', a2aBaseUrl: 'https://proof.example.com',
} as Config;

function inputs(extra: Record<string, unknown> = {}) {
  return {
    signal_hash: '0x' + '11'.repeat(32),
    nullifier: ethers.hexlify(computeWalletNullifier(WALLET, 'coinbase_attestation', ethers.getBytes(SCOPE))),
    scope_bytes: SCOPE,
    merkle_root: '0x' + '44'.repeat(32), user_address: WALLET, raw_transaction: '0x00', tx_length: 1,
    signature: '0x' + '66'.repeat(65), user_pubkey_x: '0x' + '77'.repeat(32), user_pubkey_y: '0x' + '88'.repeat(32),
    coinbase_attester_pubkey_x: '0x' + '99'.repeat(32), coinbase_attester_pubkey_y: '0x' + 'aa'.repeat(32),
    merkle_proof: [], leaf_index: 0, depth: 0,
    ...extra,
  };
}

function app(config: Config, statement?: ReturnType<typeof deps>, circuitForNonce = 'coinbase_attestation') {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', createProofRoutes({ config, redis: { getdel: async () => circuitForNonce } as never, ...(statement ? { statement } : {}) }));
  return a;
}

const paid = (r: request.Test) => r
  .set('X-Payment-Nonce', 'n')
  .set('PAYMENT-SIGNATURE', Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: 'eip155:84532' }, payload: {} })).toString('base64'));

beforeEach(() => {
  calls.length = 0;
  prove.mockClear(); settle.mockClear(); verifyPayment.mockClear();
});

describe('coinbase_attestation v2 statement in the proof route', () => {
  it('reads and signs before settling, then proves with the statement as the server kind', async () => {
    const d = deps();
    const res = await paid(request(app({ ...baseConfig, paymentMode: 'testnet' }, d)).post('/api/v1/prove'))
      .send({ circuit: 'coinbase_kyc', inputs: inputs() });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['read', 'sign', 'settle']);
    expect(prove).toHaveBeenCalledOnce();
    const params = prove.mock.calls[0][1] as { statement: { clientData: Uint8Array; signature: Uint8Array; attestedAt: number } };
    expect(params.statement.clientData.length).toBe(225);
    expect(params.statement.signature.length).toBe(64);
    expect(Number.isSafeInteger(params.statement.attestedAt)).toBe(true);
  });

  it('settles nothing for a revoked attestation and answers 403', async () => {
    const res = await paid(request(app({ ...baseConfig, paymentMode: 'testnet' }, deps(7n))).post('/api/v1/prove'))
      .send({ circuit: 'coinbase_attestation', inputs: inputs() });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('COINBASE_ATTESTATION_REVOKED');
    expect(settle).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });

  it('settles nothing for a v1 nullifier and says to update the SDK', async () => {
    const d = deps();
    const v1 = ethers.keccak256(ethers.concat([ethers.keccak256(ethers.concat([WALLET, '0x' + '11'.repeat(32)])), SCOPE]));
    const res = await paid(request(app({ ...baseConfig, paymentMode: 'testnet' }, d)).post('/api/v1/prove'))
      .send({ circuit: 'coinbase_attestation', inputs: inputs({ nullifier: v1 }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NULLIFIER_RULE');
    expect(res.body.message).toMatch(/update the SDK/);
    expect(d.signer.signDigest).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it.each([
    ['signal_hash', '0x1234'],
    ['signal_hash', 'not hex'],
    ['scope_bytes', '0x' + 'zz'.repeat(32)],
    ['nullifier', '0x' + '00'.repeat(33)],
    ['nullifier', '<script>'],
    ['signal_hash', '한글'],
    ['user_address', '0x' + '12'.repeat(19)],
    ['user_address', 12345],
  ])('refuses %s = %j with 400 before reading anything', async (field, value) => {
    const d = deps();
    const res = await paid(request(app({ ...baseConfig, paymentMode: 'testnet' }, d)).post('/api/v1/prove'))
      .send({ circuit: 'coinbase_attestation', inputs: inputs({ [field]: value }) });
    expect(res.status).toBe(400);
    expect(d.reader.latestUid).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it.each(['signal_hash', 'nullifier', 'scope_bytes', 'user_address'])('refuses a missing %s', async (field) => {
    const d = deps();
    const body = inputs();
    delete (body as Record<string, unknown>)[field];
    const res = await request(app(baseConfig, d)).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: 'coinbase_attestation', inputs: body });
    expect(res.status).toBe(400);
    expect(d.signer.signDigest).not.toHaveBeenCalled();
  });

  it('refuses an E2E-encrypted Coinbase payload: the server cannot sign what it cannot read', async () => {
    const d = deps();
    const res = await request(app({ ...baseConfig, teeMode: 'nitro' }, d)).post('/api/v1/prove').set('X-Payment-Nonce', 'n')
      .send({ circuit: 'coinbase_attestation', encrypted_payload: { keyId: 'k' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('E2E_UNSUPPORTED');
    expect(d.signer.signDigest).not.toHaveBeenCalled();
  });

  it('never proves a Coinbase request on routes built without a signer', async () => {
    const res = await request(app(baseConfig)).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: 'coinbase_attestation', inputs: inputs() });
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/statement signer is not configured/);
    expect(prove).not.toHaveBeenCalled();
  });

  it('does not touch the reader or signer for another circuit', async () => {
    const d = deps();
    const res = await request(app(baseConfig, d, 'giwa_attestation')).post('/api/v1/prove').set('X-Payment-Nonce', 'n')
      .send({ circuit: 'giwa_attestation', inputs: inputs({ nullifier: '0x' + '22'.repeat(32) }) });
    expect(res.status).toBe(200);
    expect(d.reader.latestUid).not.toHaveBeenCalled();
    expect(d.signer.signDigest).not.toHaveBeenCalled();
    expect(prove.mock.calls[0][1]).not.toHaveProperty('statement');
  });

  it('binds an action on coinbase_attestation: the statement carries the EIP-712 digest, the prover the pair', async () => {
    const d = deps();
    const ds = '0x' + 'aa'.repeat(32), ah = '0x' + 'bb'.repeat(32);
    const res = await request(app(baseConfig, d)).post('/api/v1/prove').set('X-Payment-Nonce', 'n')
      .send({ circuit: 'coinbase_attestation', inputs: inputs({ domain_separator: ds, action_hash: ah }) });
    expect(res.status).toBe(200);
    const params = prove.mock.calls[0][1] as { domainSeparator: string; actionHash: string; statement: { clientData: Uint8Array } };
    expect(params).toMatchObject({ domainSeparator: ds, actionHash: ah });
    expect(ethers.hexlify(params.statement.clientData.slice(161, 193))).toBe(ethers.keccak256(ethers.concat(['0x1901', ds, ah])));
  });

  it('refuses half an action on coinbase_attestation before reading the attestation', async () => {
    const d = deps();
    const res = await request(app(baseConfig, d)).post('/api/v1/prove').set('X-Payment-Nonce', 'n')
      .send({ circuit: 'coinbase_attestation', inputs: inputs({ domain_separator: '0x' + 'aa'.repeat(32) }) });
    expect(res.status).toBe(400);
    expect(d.reader.latestUid).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });

  it('signs a fresh statement per request (no reuse across concurrent requests)', async () => {
    const d = deps();
    const a = app(baseConfig, d);
    const [r1, r2] = await Promise.all([
      request(a).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: 'coinbase_attestation', inputs: inputs() }),
      request(a).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: 'coinbase_attestation', inputs: inputs({ signal_hash: '0x' + '12'.repeat(32) }) }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(d.signer.signDigest).toHaveBeenCalledTimes(2);
    const digests = prove.mock.calls.map(c => ethers.hexlify((c[1] as { statement: { clientData: Uint8Array } }).statement.clientData.slice(161, 193)));
    expect(new Set(digests).size).toBe(2);
  });
});
