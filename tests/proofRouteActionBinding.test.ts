import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createProofRoutes } from '../src/proof/proofRoutes.js';
import type { Config } from '../src/config/index.js';

const prove = vi.hoisted(() => vi.fn(async () => ({ proof: '0x11', publicInputs: '0x22', proofWithInputs: '0x1122' })));
vi.mock('../src/prover/bbProver.js', () => ({ BbProver: class { prove = prove; } }));
const config = {
  paymentMode: 'disabled', paymentNetworks: 'base-sepolia', paymentProofPrice: '$0', paymentPayTo: '0x' + '11'.repeat(20),
  teeMode: 'local', chainRpcUrl: 'https://sepolia.base.org', a2aBaseUrl: 'https://proof.example.com',
} as Config;
const inputs = {
  signal_hash: '0x' + '11'.repeat(32), nullifier: '0x' + '22'.repeat(32), scope_bytes: '0x' + '33'.repeat(32),
  merkle_root: '0x' + '44'.repeat(32), user_address: '0x' + '55'.repeat(20), raw_transaction: '0x00',
  signature: '0x' + '66'.repeat(65), user_pubkey_x: '0x' + '77'.repeat(32), user_pubkey_y: '0x' + '88'.repeat(32),
};
const pair = { domain_separator: '0x' + 'aa'.repeat(32), action_hash: '0x' + 'bb'.repeat(32) };
async function submit(circuit: string, extra: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createProofRoutes({ config, redis: { getdel: async () => circuit } as never }));
  return request(app).post('/api/v1/prove').set('X-Payment-Nonce', 'test-nonce').send({ circuit, inputs: { ...inputs, ...extra } });
}
beforeEach(() => prove.mockClear());
describe('HTTP proof route preserves optional action policy', () => {
  it.each(['arc_eligibility', 'giwa_attestation'])('%s accepts an identity-only witness without action', async circuit => {
    const response = await submit(circuit);
    expect(response.status).toBe(200);
    expect(response.body.proofType).toBe(circuit);
    expect(prove).toHaveBeenCalledOnce();
    expect(prove.mock.calls[0][1]).not.toHaveProperty('actionHash');
  });
  it.each(['arc_eligibility', 'giwa_attestation'])('%s forwards the complete action pair unchanged', async circuit => {
    const response = await submit(circuit, pair);
    expect(response.status).toBe(200);
    expect(prove.mock.calls[0][1]).toMatchObject({ domainSeparator: pair.domain_separator, actionHash: pair.action_hash });
  });
  for (const circuit of ['arc_eligibility', 'giwa_attestation']) {
    it.each([{ domain_separator: pair.domain_separator }, { action_hash: pair.action_hash }])(`${circuit} refuses half an action instead of dropping it`, async extra => {
      const response = await submit(circuit, extra);
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/both domain_separator and action_hash/);
      expect(prove).not.toHaveBeenCalled();
    });
  }
  it.each(['coinbase_attestation', 'coinbase_country_attestation'])('%s refuses an unsupported action before proving', async circuit => {
    const response = await submit(circuit, { ...pair, country_list: ['KR'], is_included: true });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain('does not support action binding');
    expect(prove).not.toHaveBeenCalled();
  });
});

describe('encrypted proof response metadata', () => {
  it.each(['arc_eligibility', 'giwa_attestation'])('%s does not claim to be a Google login', async circuit => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createProofRoutes({ config: { ...config, teeMode: 'nitro' }, redis: { getdel: async () => circuit } as never,
      teeProvider: { proveEncrypted: async () => ({ type: 'proof', proof: '0x11', publicInputs: ['0x22'] }) } as never }));
    const response = await request(app).post('/api/v1/prove').set('X-Payment-Nonce', 'test-nonce').send({ circuit, encrypted_payload: { keyId: 'opaque' } });
    expect(response.status).toBe(200);
    expect(response.body.proofType).toBe(circuit);
  });
});

describe('action hash input boundaries', () => {
  it.each([null, '', ' ', '0x00', '0x' + 'ab'.repeat(33), '한글', '<script>', '0x' + '00'.repeat(32) + '\n'])('refuses malformed action hash %j before proving', async actionHash => {
    const response = await submit('giwa_attestation', { ...pair, action_hash: actionHash });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain('32-byte hash');
    expect(prove).not.toHaveBeenCalled();
  });
});

describe('OIDC action rejection', () => {
  const oidc = { jwt: 'opaque.id.token', jwks: { keys: [] }, scope: 'test', provider: 'google' };
  it('rejects an action pair instead of silently ignoring it', async () => {
    const response = await submit('oidc_domain_attestation', { ...oidc, ...pair });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain('does not support action binding');
    expect(prove).not.toHaveBeenCalled();
  });
  it.each([{ domain_separator: pair.domain_separator }, { action_hash: pair.action_hash }])('rejects half an action before the OIDC input branch', async extra => {
    const response = await submit('oidc_domain_attestation', { ...oidc, ...extra });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain('both domain_separator and action_hash');
    expect(prove).not.toHaveBeenCalled();
  });
});
