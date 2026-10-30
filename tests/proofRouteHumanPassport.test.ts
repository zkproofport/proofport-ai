/**
 * POST /api/v1/prove for human_passport_score: the issuance is found and
 * checked BEFORE settlement, so every refusal is free, and the prover gets
 * the server's issuance and clock, never the caller's.
 *
 *   order     lookup before settle; a refusal settles nothing and proves nothing
 *   contract  reader asked for the request's wallet; prover gets the issuance,
 *             the threshold in units and the server's now
 *   authz     no score -> 403; below threshold -> 403; lookup down -> 503
 *   hostile   caller-sent now / issuance fields are ignored
 *   E2E       encrypted payload refused; route without a reader -> 500, no proof
 *   alias     `human_passport` and the canonical id both reach it
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const calls = vi.hoisted(() => [] as string[]);
const prove = vi.hoisted(() => vi.fn(async () => ({ proof: '0x11', publicInputs: '0x22', proofWithInputs: '0x1122' })));
vi.mock('../src/prover/bbProver.js', () => ({ BbProver: class { prove = prove; } }));
const settle = vi.hoisted(() => vi.fn(async () => { calls.push('settle'); return { txHash: '0x' + 'ab'.repeat(32), via: 'test' }; }));
vi.mock('../src/payment/settle.js', () => ({ settlePayment: settle }));
const verifyPayment = vi.hoisted(() => vi.fn(async () => ({ valid: true })));
vi.mock('../src/proof/paymentVerifier.js', () => ({ verifyPaymentOnChain: verifyPayment }));

import { createProofRoutes } from '../src/proof/proofRoutes.js';
import type { HumanPassportReader } from '../src/input/humanPassport.js';
import type { Config } from '../src/config/index.js';
import { HUMAN_PASSPORT_SCORE_SCHEMA } from '@zkproofport-app/core/circuits';
import { buildIssuance, requestInputs, TEST_WALLET } from './helpers/humanPassportFixture.js';

const ID = 'human_passport_score';
const NOW_MS = 1_800_000_000_000;

function reader(b = buildIssuance(), over: { none?: boolean; down?: boolean } = {}): HumanPassportReader {
  return {
    latest: vi.fn(async () => {
      calls.push('lookup');
      if (over.down) throw new Error('EAS GraphQL request failed: HTTP 503');
      return over.none ? null : { uid: '0x' + 'ab'.repeat(32), txid: '0x' + 'cd'.repeat(32) };
    }),
    onChain: vi.fn(async (uid: string) => ({
      uid, schema: HUMAN_PASSPORT_SCORE_SCHEMA, recipient: TEST_WALLET.address, attester: '0xCc90105D4A2aa067ee768120AdA19886021dF422',
      revocationTime: 0n, expirationTime: 1_900_000_000n, data: b.data,
    })),
    calldata: vi.fn(async () => b.calldata),
  };
}

const baseConfig = {
  paymentMode: 'testnet', paymentNetworks: 'base-sepolia', paymentProofPrice: '$0.10', paymentPayTo: '0x' + '11'.repeat(20),
  teeMode: 'local', chainRpcUrl: 'https://sepolia.base.org', a2aBaseUrl: 'https://proof.example.com',
} as Config;

function app(config: Config, r?: HumanPassportReader) {
  const b = buildIssuance();
  const a = express();
  a.use(express.json());
  a.use('/api/v1', createProofRoutes({
    config,
    redis: { getdel: async () => ID } as never,
    ...(r ? { humanPassport: { reader: r, now: () => NOW_MS, anchors: b.anchors } } : {}),
  } as never));
  return a;
}

const paid = (r: request.Test) => r
  .set('X-Payment-Nonce', 'n')
  .set('PAYMENT-SIGNATURE', Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: 'eip155:84532' }, payload: {} })).toString('base64'));

beforeEach(() => {
  calls.length = 0;
  prove.mockClear(); settle.mockClear(); verifyPayment.mockClear();
});

describe('human_passport_score in the proof route', () => {
  it.each(['human_passport', ID])('looks the score up before settling, then proves with the server\'s issuance (%s)', async circuit => {
    const r = reader();
    const res = await paid(request(app(baseConfig, r)).post('/api/v1/prove'))
      .send({ circuit, inputs: { ...(await requestInputs()), now: 1, issuance: { score: 999999 } } });
    expect(res.status).toBe(200);
    expect(res.body.proofType).toBe('human_passport_score');
    expect(calls).toEqual(['lookup', 'settle']);
    expect(r.latest).toHaveBeenCalledWith(TEST_WALLET.address, NOW_MS / 1000);
    const params = prove.mock.calls[0][1] as { now: number; minScoreUnits: number; issuance: { request: { recipient: string }; score: number } };
    expect(prove.mock.calls[0][0]).toBe(ID);
    expect(params.now).toBe(NOW_MS / 1000);
    expect(params.minScoreUnits).toBe(200000);
    expect(params.issuance.request.recipient).toBe(TEST_WALLET.address);
    expect(params.issuance.score).not.toBe(999999);
  });

  it.each([
    ['no score', { none: true }, 403, 'NO_HUMAN_PASSPORT_SCORE'],
    ['a lookup that did not answer', { down: true }, 503, 'HUMAN_PASSPORT_LOOKUP_FAILED'],
  ] as const)('settles nothing for %s', async (_n, over, status, code) => {
    const res = await paid(request(app(baseConfig, reader(buildIssuance(), over))).post('/api/v1/prove'))
      .send({ circuit: 'human_passport', inputs: await requestInputs() });
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
    expect(settle).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });

  it('settles nothing below the threshold', async () => {
    const res = await paid(request(app(baseConfig, reader())).post('/api/v1/prove'))
      .send({ circuit: 'human_passport', inputs: await requestInputs({ minScore: 99 }) });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('HUMAN_PASSPORT_SCORE_BELOW_THRESHOLD');
    expect(settle).not.toHaveBeenCalled();
  });

  it('refuses a missing threshold before looking anything up', async () => {
    const r = reader();
    const res = await paid(request(app(baseConfig, r)).post('/api/v1/prove'))
      .send({ circuit: 'human_passport', inputs: await requestInputs({ minScore: undefined }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
    expect(r.latest).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('refuses an E2E-encrypted payload', async () => {
    const res = await request(app({ ...baseConfig, teeMode: 'nitro' }, reader())).post('/api/v1/prove').set('X-Payment-Nonce', 'n')
      .send({ circuit: ID, encrypted_payload: { keyId: 'k' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('E2E_UNSUPPORTED');
  });

  it('errors without proving on a server built with no issuance reader', async () => {
    const res = await paid(request(app(baseConfig)).post('/api/v1/prove'))
      .send({ circuit: ID, inputs: await requestInputs() });
    expect(res.status).toBe(500);
    expect(settle).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });
});
