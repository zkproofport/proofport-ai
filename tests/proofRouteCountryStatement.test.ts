/**
 * POST /api/v1/prove for coinbase_country_attestation v2: the same order as
 * Coinbase KYC v2 (statement before settlement, refusals free), plus the
 * Country rules: the request's attestCountry transaction must name the
 * country the unrevoked attestation names, and the public country list must
 * be one the circuit accepts -- both checked before any payment.
 *
 * Matrix rows covered here (the statement module's rows are in
 * coinbaseStatement.test.ts):
 *   contract   reader asked for the Country schema; signer called once; prover gets a 227-byte statement
 *   order      read and sign before settle; a refusal settles nothing
 *   boundary   country_list of 0 / 1 / 10 / 11 entries
 *   hostile    lowercase / 3-letter / Korean list entries; a KYC (attestAccount) transaction; a country mismatch
 *   empty      missing country_list / is_included
 *   authz      revoked attestation -> 403; v1 or KYC-tag nullifier -> 400
 *   E2E        encrypted payload refused
 *   race       two concurrent requests get two statements
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
import { COINBASE_COUNTRY_SCHEMA, type AttestationReader, type StatementSigner } from '../src/input/coinbaseStatement.js';
import { COINBASE_ATTESTER_CONTRACT } from '../src/config/contracts.js';
import type { Config } from '../src/config/index.js';
import { p256 as nobleP256 } from '@noble/curves/p256';
import { createPublicKey } from 'node:crypto';

const ID = 'coinbase_country_attestation';
const WALLET = '0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739';
const UID = '0x' + '5a'.repeat(32);
const SCOPE = ethers.keccak256(ethers.toUtf8Bytes('proofport'));
const ATTESTER_KEY = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('country route attester')));

const priv = nobleP256.utils.randomPrivateKey();
const pub = nobleP256.getPublicKey(priv, false);
const PEM = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(pub.slice(1, 33)).toString('base64url'), y: Buffer.from(pub.slice(33)).toString('base64url') }, format: 'jwk' })
  .export({ format: 'pem', type: 'spki' }).toString();

async function countryTx(country = 'KR', selector = '0x0a225248') {
  const raw = await ATTESTER_KEY.signTransaction({
    type: 2, chainId: 8453, nonce: 1, to: COINBASE_ATTESTER_CONTRACT, gasLimit: 100000, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
    data: ethers.concat([selector, '0x' + '00'.repeat(10), ethers.toUtf8Bytes(country), WALLET]),
  });
  return { raw_transaction: raw, tx_length: ethers.getBytes(raw).length };
}

function deps(o: { revocationTime?: bigint; country?: string } = {}) {
  const reader: AttestationReader & { latestUid: ReturnType<typeof vi.fn>; onChain: ReturnType<typeof vi.fn> } = {
    latestUid: vi.fn(async () => { calls.push('read'); return UID; }),
    onChain: vi.fn(async (uid: string) => ({
      uid, schema: COINBASE_COUNTRY_SCHEMA, recipient: WALLET, attester: COINBASE_ATTESTER_CONTRACT,
      revocationTime: o.revocationTime ?? 0n, expirationTime: 0n,
      data: ethers.AbiCoder.defaultAbiCoder().encode(['string'], [o.country ?? 'KR']),
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

async function inputs(extra: Record<string, unknown> = {}, txCountry = 'KR') {
  return {
    signal_hash: '0x' + '11'.repeat(32),
    nullifier: ethers.hexlify(computeWalletNullifier(WALLET, ID, ethers.getBytes(SCOPE))),
    scope_bytes: SCOPE,
    merkle_root: '0x' + '44'.repeat(32), user_address: WALLET, ...(await countryTx(txCountry)),
    signature: '0x' + '66'.repeat(65), user_pubkey_x: '0x' + '77'.repeat(32), user_pubkey_y: '0x' + '88'.repeat(32),
    coinbase_attester_pubkey_x: '0x' + '99'.repeat(32), coinbase_attester_pubkey_y: '0x' + 'aa'.repeat(32),
    merkle_proof: [], leaf_index: 0, depth: 0,
    country_list: ['US', 'KR'], is_included: true,
    ...extra,
  };
}

function app(config: Config, statement?: ReturnType<typeof deps>) {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', createProofRoutes({ config, redis: { getdel: async () => ID } as never, ...(statement ? { statement } : {}) }));
  return a;
}

const paid = (r: request.Test) => r
  .set('X-Payment-Nonce', 'n')
  .set('PAYMENT-SIGNATURE', Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: 'eip155:84532' }, payload: {} })).toString('base64'));

beforeEach(() => {
  calls.length = 0;
  prove.mockClear(); settle.mockClear(); verifyPayment.mockClear();
});

describe('coinbase_country_attestation v2 statement in the proof route', () => {
  it('reads and signs before settling, then proves with a 227-byte statement naming the country', async () => {
    const d = deps();
    const res = await paid(request(app({ ...baseConfig, paymentMode: 'testnet' }, d)).post('/api/v1/prove'))
      .send({ circuit: 'coinbase_country', inputs: await inputs() });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['read', 'sign', 'settle']);
    expect(d.reader.latestUid).toHaveBeenCalledWith(ID, WALLET);
    const params = prove.mock.calls[0][1] as { statement: { clientData: Uint8Array }; countryList: string[]; isIncluded: boolean };
    expect(params.statement.clientData.length).toBe(227);
    expect(new TextDecoder().decode(params.statement.clientData.slice(225))).toBe('KR');
    expect(params).toMatchObject({ countryList: ['US', 'KR'], isIncluded: true });
  });

  it('settles nothing when the transaction attests another country than the current attestation', async () => {
    const d = deps({ country: 'KR' });
    const res = await paid(request(app({ ...baseConfig, paymentMode: 'testnet' }, d)).post('/api/v1/prove'))
      .send({ circuit: ID, inputs: await inputs({}, 'US') });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('COINBASE_COUNTRY_MISMATCH');
    expect(d.signer.signDigest).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });

  it('settles nothing for a revoked Country attestation', async () => {
    const res = await paid(request(app({ ...baseConfig, paymentMode: 'testnet' }, deps({ revocationTime: 3n }))).post('/api/v1/prove'))
      .send({ circuit: ID, inputs: await inputs() });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('COINBASE_ATTESTATION_REVOKED');
    expect(settle).not.toHaveBeenCalled();
  });

  it('refuses a KYC (attestAccount) transaction before reading anything', async () => {
    const d = deps();
    const kyc = await countryTx('KR', '0x56feed5e');
    const res = await request(app(baseConfig, d)).post('/api/v1/prove').set('X-Payment-Nonce', 'n')
      .send({ circuit: ID, inputs: await inputs(kyc) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
    expect(d.reader.latestUid).not.toHaveBeenCalled();
  });

  it.each([
    ['a v1 (signal-hash) nullifier', () => ethers.keccak256(ethers.concat([ethers.keccak256(ethers.concat([WALLET, '0x' + '11'.repeat(32)])), SCOPE]))],
    ["the KYC tag's nullifier", () => ethers.hexlify(computeWalletNullifier(WALLET, 'coinbase_attestation', ethers.getBytes(SCOPE)))],
  ])('refuses %s before reading anything', async (_name, nullifier) => {
    const d = deps();
    const res = await request(app(baseConfig, d)).post('/api/v1/prove').set('X-Payment-Nonce', 'n')
      .send({ circuit: ID, inputs: await inputs({ nullifier: nullifier() }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NULLIFIER_RULE');
    expect(d.reader.latestUid).not.toHaveBeenCalled();
  });

  it.each([
    ['no list', { country_list: undefined }, /country_list required/],
    ['an empty list', { country_list: [] }, /country_list required/],
    ['11 codes', { country_list: Array(11).fill('US') }, /at most 10/],
    ['a lowercase code', { country_list: ['kr'] }, /not an ISO 3166-1 alpha-2 code/],
    ['a 3-letter code', { country_list: ['KOR'] }, /not an ISO 3166-1 alpha-2 code/],
    ['a Korean code', { country_list: ['한국'] }, /not an ISO 3166-1 alpha-2 code/],
    ['a number', { country_list: [82] }, /not an ISO 3166-1 alpha-2 code/],
    ['no is_included', { is_included: undefined }, /is_included required/],
  ])('refuses %s before reading anything or charging', async (_name, extra, message) => {
    const d = deps();
    const res = await paid(request(app({ ...baseConfig, paymentMode: 'testnet' }, d)).post('/api/v1/prove'))
      .send({ circuit: ID, inputs: await inputs(extra) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(d.reader.latestUid).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('accepts exactly 10 codes', async () => {
    const res = await request(app(baseConfig, deps())).post('/api/v1/prove').set('X-Payment-Nonce', 'n')
      .send({ circuit: ID, inputs: await inputs({ country_list: ['KR', 'US', 'JP', 'DE', 'FR', 'GB', 'CA', 'AU', 'SG', 'NZ'] }) });
    expect(res.status).toBe(200);
    expect((prove.mock.calls[0][1] as { countryListLength: number }).countryListLength).toBe(10);
  });

  it('refuses an E2E-encrypted Country payload', async () => {
    const d = deps();
    const res = await request(app({ ...baseConfig, teeMode: 'nitro' }, d)).post('/api/v1/prove').set('X-Payment-Nonce', 'n')
      .send({ circuit: ID, encrypted_payload: { keyId: 'k' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('E2E_UNSUPPORTED');
  });

  it('binds an action on Country: the statement carries the EIP-712 digest, the prover the pair', async () => {
    const d = deps();
    const ds = '0x' + 'aa'.repeat(32), ah = '0x' + 'bb'.repeat(32);
    const res = await request(app(baseConfig, d)).post('/api/v1/prove').set('X-Payment-Nonce', 'n')
      .send({ circuit: ID, inputs: await inputs({ domain_separator: ds, action_hash: ah }) });
    expect(res.status).toBe(200);
    const params = prove.mock.calls[0][1] as { domainSeparator: string; actionHash: string; statement: { clientData: Uint8Array } };
    expect(params).toMatchObject({ domainSeparator: ds, actionHash: ah });
    expect(ethers.hexlify(params.statement.clientData.slice(161, 193))).toBe(ethers.keccak256(ethers.concat(['0x1901', ds, ah])));
  });

  it('signs a fresh statement per request', async () => {
    const d = deps();
    const a = app(baseConfig, d);
    const [r1, r2] = await Promise.all([
      request(a).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: ID, inputs: await inputs() }),
      request(a).post('/api/v1/prove').set('X-Payment-Nonce', 'n').send({ circuit: ID, inputs: await inputs({ signal_hash: '0x' + '12'.repeat(32) }) }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(d.signer.signDigest).toHaveBeenCalledTimes(2);
  });
});
