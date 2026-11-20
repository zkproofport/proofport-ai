/**
 * The proof route and the OPRF nullifier inputs.
 *
 *   contract   readOprfInputs is called (spied) for every wallet circuit with
 *              the deployment's environment, the circuit and the body; the
 *              prover gets its values as `oprf`
 *   order      every OPRF refusal happens before settlement, payment
 *              verification, the attestation read and the prover
 *   env        OPRF_ENVIRONMENT unset -> 503 OPRF_NOT_CONFIGURED; production
 *              -> 503 naming production, for all four wallet circuits,
 *              plaintext and encrypted
 *   key hash   another key hash -> 400 OPRF_KEY_HASH_MISMATCH
 *   x402       OIDC never reaches the OPRF check (no OPRF keys, env unset or
 *              production); the 402 challenge is issued as before
 *   discovery  GET /api/v1/oprf -> 200 { environment } / 503 when unset
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const calls = vi.hoisted(() => [] as string[]);
const prove = vi.hoisted(() => vi.fn(async () => ({ proof: '0x11', publicInputs: '0x22', proofWithInputs: '0x1122' })));
vi.mock('../src/prover/bbProver.js', () => ({ BbProver: class { prove = prove; } }));
const settle = vi.hoisted(() => vi.fn(async () => { calls.push('settle'); return { txHash: '0x' + 'ab'.repeat(32), via: 'test' }; }));
vi.mock('../src/payment/settle.js', () => ({ settlePayment: settle }));
const verifyPayment = vi.hoisted(() => vi.fn(async () => { calls.push('verify'); return { valid: true }; }));
vi.mock('../src/proof/paymentVerifier.js', () => ({ verifyPaymentOnChain: verifyPayment }));
const readSpy = vi.hoisted(() => ({ fn: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock('../src/input/oprfInputs.js', async (orig) => {
  const real = await orig<typeof import('../src/input/oprfInputs.js')>();
  readSpy.fn = vi.fn(real.readOprfInputs);
  return { ...real, readOprfInputs: readSpy.fn };
});

import { createProofRoutes } from '../src/proof/proofRoutes.js';
import type { Config } from '../src/config/index.js';
import { oprfWireInputs, oprfParams, NETWORK } from './helpers/oprfInputs.js';

const base = {
  paymentMode: 'testnet', paymentNetworks: 'base-sepolia', paymentProofPrice: '$0.10', paymentPayTo: '0x' + '11'.repeat(20),
  teeMode: 'local', chainRpcUrl: 'https://sepolia.base.org', a2aBaseUrl: 'https://proof.example.com',
} as Config;
const cfg = (oprfEnvironment: Config['oprfEnvironment'], extra: Partial<Config> = {}) => ({ ...base, oprfEnvironment, ...extra }) as Config;

const giwaInputs = (extra: Record<string, unknown> = {}) => ({
  signal_hash: '0x' + '11'.repeat(32), ...oprfWireInputs(),
  merkle_root: '0x' + '44'.repeat(32), user_address: '0x' + '55'.repeat(20), raw_transaction: '0x00', tx_length: 1,
  signature: '0x' + '66'.repeat(65), user_pubkey_x: '0x' + '77'.repeat(32), user_pubkey_y: '0x' + '88'.repeat(32),
  coinbase_attester_pubkey_x: '0x' + '99'.repeat(32), coinbase_attester_pubkey_y: '0x' + 'aa'.repeat(32),
  merkle_proof: [], leaf_index: 0, depth: 0,
  ...extra,
});

function app(config: Config, nonceCircuit: string, deps: Record<string, unknown> = {}) {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', createProofRoutes({ config, redis: { getdel: async () => nonceCircuit, set: async () => 'OK' } as never, ...deps } as never));
  return a;
}

const paid = (r: request.Test) => r
  .set('X-Payment-Nonce', 'n')
  .set('PAYMENT-SIGNATURE', Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: 'eip155:84532' }, payload: {} })).toString('base64'));

beforeEach(() => {
  calls.length = 0;
  prove.mockClear(); settle.mockClear(); verifyPayment.mockClear(); readSpy.fn.mockClear();
});

const WALLET_CIRCUITS = ['coinbase_attestation', 'coinbase_country_attestation', 'giwa_attestation', 'human_passport_score'] as const;

describe('OPRF inputs in the proof route', () => {
  it('checks giwa_attestation\'s OPRF values before settling and hands them to the prover', async () => {
    const res = await paid(request(app(cfg('staging'), 'giwa_attestation')).post('/api/v1/prove'))
      .send({ circuit: 'giwa_attestation', inputs: giwaInputs() });
    expect(res.status).toBe(200);
    expect(readSpy.fn).toHaveBeenCalledOnce();
    expect(readSpy.fn.mock.calls[0][0]).toBe('staging');
    expect(readSpy.fn.mock.calls[0][1]).toBe('giwa_attestation');
    expect(calls).toEqual(['settle', 'verify']);
    expect((prove.mock.calls[0] as unknown[])[1]).toMatchObject({ oprf: oprfParams() });
  });

  it('refuses another key hash with 400 and charges nothing', async () => {
    const other = '0x' + (BigInt(NETWORK.keyHash) + 1n).toString(16).padStart(64, '0');
    const res = await paid(request(app(cfg('staging'), 'giwa_attestation')).post('/api/v1/prove'))
      .send({ circuit: 'giwa_attestation', inputs: giwaInputs({ oprf_key_hash: other }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OPRF_KEY_HASH_MISMATCH');
    expect(settle).not.toHaveBeenCalled();
    expect(verifyPayment).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });

  it.each([
    ['a scope at p', { scope: '0x' + 21888242871839275222246405745257275088548364400416034343698204186575808495617n.toString(16).padStart(64, '0') }],
    ['beta zero', { oprf_beta: '0x' + '00'.repeat(32) }],
    ['a missing nullifier', { nullifier: undefined }],
    ['the old scope_bytes instead of scope', { scope: undefined, scope_bytes: '0x' + '33'.repeat(32) }],
  ])('refuses %s with 400 before settlement', async (_n, extra) => {
    const res = await paid(request(app(cfg('local'), 'giwa_attestation')).post('/api/v1/prove'))
      .send({ circuit: 'giwa_attestation', inputs: giwaInputs(extra) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
    expect(settle).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
  });

  for (const circuit of WALLET_CIRCUITS) {
    it(`${circuit}: OPRF_ENVIRONMENT unset -> 503 naming it, nothing read, charged or proved`, async () => {
      const reader = { latestUid: vi.fn(), onChain: vi.fn(), latest: vi.fn() };
      const res = await paid(request(app(cfg(undefined), circuit, { statement: { reader, signer: {} }, humanPassport: { reader } })).post('/api/v1/prove'))
        .send({ circuit, inputs: giwaInputs({ country_list: ['KR'], is_included: true, min_score: 20, chain: 8453 }) });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('OPRF_NOT_CONFIGURED');
      expect(res.body.message).toMatch(/OPRF_ENVIRONMENT/);
      expect(reader.latestUid).not.toHaveBeenCalled();
      expect(reader.latest).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      expect(verifyPayment).not.toHaveBeenCalled();
      expect(prove).not.toHaveBeenCalled();
    });

    it(`${circuit}: production -> 503 naming production, before payment`, async () => {
      const reader = { latestUid: vi.fn(), onChain: vi.fn(), latest: vi.fn() };
      const res = await paid(request(app(cfg('production'), circuit, { statement: { reader, signer: {} }, humanPassport: { reader } })).post('/api/v1/prove'))
        .send({ circuit, inputs: giwaInputs({ country_list: ['KR'], is_included: true, min_score: 20, chain: 8453 }) });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('OPRF_UNAVAILABLE');
      expect(res.body.message).toContain("'production'");
      expect(reader.latestUid).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      expect(verifyPayment).not.toHaveBeenCalled();
      expect(prove).not.toHaveBeenCalled();
    });
  }

  it.each([[undefined, 'OPRF_NOT_CONFIGURED'], ['production', 'OPRF_UNAVAILABLE']] as const)(
    'an encrypted giwa payload is refused when the environment is %s, before payment', async (env, code) => {
      const res = await paid(request(app(cfg(env, { teeMode: 'nitro' }), 'giwa_attestation')).post('/api/v1/prove'))
        .send({ circuit: 'giwa_attestation', encrypted_payload: { keyId: 'k', ephemeralPublicKey: 'x', iv: 'x', ciphertext: 'x', authTag: 'x' } });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe(code);
      expect(readSpy.fn).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
    });
});

describe('x402 and OIDC are unaffected', () => {
  it.each([undefined, 'production'] as const)('OIDC never reaches the OPRF check (environment %s)', async (env) => {
    const res = await paid(request(app(cfg(env), 'oidc_domain_attestation')).post('/api/v1/prove'))
      .send({ circuit: 'oidc_domain_attestation', inputs: { scope: 's' } });
    // Refused by the OIDC field check, not by anything OPRF.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
    expect(res.body.message).toMatch(/OIDC fields/);
    expect(readSpy.fn).not.toHaveBeenCalled();
  });

  it.each(['giwa_attestation', 'oidc_domain_attestation'])('the 402 challenge for %s is issued with OPRF_ENVIRONMENT unset', async (circuit) => {
    const res = await request(app(cfg(undefined), circuit)).post('/api/v1/prove').send({ circuit });
    expect(res.status).toBe(402);
    expect(res.body.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(readSpy.fn).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/oprf', () => {
  it.each(['production', 'staging', 'local'] as const)('answers { environment: %s }', async (env) => {
    const res = await request(app(cfg(env), 'x')).get('/api/v1/oprf');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ environment: env });
  });

  it('answers 503 OPRF_NOT_CONFIGURED when unset', async () => {
    const res = await request(app(cfg(undefined), 'x')).get('/api/v1/oprf');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('OPRF_NOT_CONFIGURED');
  });
});
