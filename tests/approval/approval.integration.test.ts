import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { Wallet } from 'ethers';

// Real Redis through the repository's Docker selector; this is HTTP/Redis
// integration with test EOAs, not a real-wallet or paid-proof E2E test.
const enabled = process.env.APPROVAL_REDIS_INTEGRATION === '1';
const run = promisify(execFile);
const redis = {
  async eval(script: string, count: number, ...args: (string | number)[]) {
    const result = await run('bash', ['scripts/ai-compose.sh', 'exec', '-T', 'redis',
      'redis-cli', '--json', 'EVAL', script, String(count), ...args.map(String)], { maxBuffer: 256 * 1024 });
    return JSON.parse(result.stdout);
  },
};
const alice = new Wallet('0x' + '11'.repeat(32));
const bob = new Wallet('0x' + '22'.repeat(32));
const action = {
  domain: { name: 'Test action', version: '1', chainId: 91342, verifyingContract: '0x' + '33'.repeat(20) },
  types: { Action: [{ name: 'amount', type: 'uint256' }, { name: 'memo', type: 'string' }, { name: 'enabled', type: 'bool' }] },
  primaryType: 'Action', message: { amount: '900719925474099300000', memo: '한글 😀 <script> % _ \\ SELECT\n\t', enabled: false },
};
const body = { circuit: 'giwa_attestation', scope: 'Gotgan', action };

async function harness(trustProxyHops?: number | false) {
  const origin = `https://${randomUUID()}.approval.example`;
  // Absence gives an ordinary 404 in RED, demonstrating the missing API.
  const module = await import('../../src/approval/routes.js').catch(() => null);
  const app = express();
  if (module) app.use('/api/v1/action-approvals', module.createActionApprovalRouter({ redis: redis as never, origin, trustProxyHops }));
  const api = request(app);
  return { app, api, origin, module };
}
function browserToken(created: { approvalUrl: string }) { return new URL(created.approvalUrl).hash.substring(1); }
function auth(token: string) { return `Bearer ${token}`; }
async function create(h: Awaited<ReturnType<typeof harness>>, extra = {}) {
  const response = await h.api.post('/api/v1/action-approvals').send({ ...body, ...extra });
  expect(response.status).toBe(201);
  return response.body;
}
async function approve(h: Awaited<ReturnType<typeof harness>>, c: any) {
  const signature = await alice.signTypedData(action.domain, action.types, action.message);
  const response = await h.api.post(`/api/v1/action-approvals/${c.approvalId}/approve`)
    .set('Authorization', auth(browserToken(c))).send({ address: alice.address, signature });
  expect(response.status).toBe(200);
  return signature;
}

describe.skipIf(!enabled)('action approval real Redis + HTTP integration (APPROVAL_REDIS_INTEGRATION=1)', { timeout: 30_000 }, () => {
  it('creates a frozen action, separates capabilities, and never exposes a signature through status', async () => {
    const h = await harness(); const c = await create(h, { expectedSigner: alice.address });
    expect(c.status).toBe('pending');
    expect(new URL(c.approvalUrl).origin).toBe(h.origin);
    expect(browserToken(c)).toMatch(/^[0-9a-f]{64}$/);
    expect(c.requesterToken).toMatch(/^[0-9a-f]{64}$/);
    expect(c.requesterToken).not.toBe(browserToken(c));
    expect(Date.parse(c.expiresAt) - Date.now()).toBeGreaterThan(590_000);
    const signature = await approve(h, c);
    for (const token of [browserToken(c), c.requesterToken]) {
      const response = await h.api.get(`/api/v1/action-approvals/${c.approvalId}`).set('Authorization', auth(token));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'approved', action, expectedSigner: alice.address, address: alice.address });
      expect(JSON.stringify(response.body)).not.toContain(signature);
      expect(JSON.stringify(response.body)).not.toContain(c.requesterToken);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    }
    const consumed = await h.api.post(`/api/v1/action-approvals/${c.approvalId}/consume`)
      .set('Authorization', auth(c.requesterToken)).send(body);
    expect(consumed.status).toBe(200);
    expect(consumed.body).toEqual({ address: alice.address, signature, ...body });
  });

  it('consumes once across two service instances and removes stored signature', async () => {
    const h = await harness(); const c = await create(h); const signature = await approve(h, c);
    const second = express(); second.use('/api/v1/action-approvals', h.module!.createActionApprovalRouter({ redis: redis as never, origin: h.origin }));
    const attempts = await Promise.all([h.api, request(second)].map(api => api.post(`/api/v1/action-approvals/${c.approvalId}/consume`)
      .set('Authorization', auth(c.requesterToken)).send(body)));
    expect(attempts.map(r => r.status).sort()).toEqual([200, 409]);
    expect(attempts.find(r => r.status === 200)!.body).toEqual({ address: alice.address, signature, ...body });
    const status = await h.api.get(`/api/v1/action-approvals/${c.approvalId}`).set('Authorization', auth(c.requesterToken));
    expect(status.body.status).toBe('consumed');
    expect(status.body).not.toHaveProperty('signature');
  });

  it('refuses wrong roles, missing credentials, and mismatched signer without approving', async () => {
    const h = await harness(); const c = await create(h, { expectedSigner: alice.address });
    const signature = await bob.signTypedData(action.domain, action.types, action.message);
    expect((await h.api.get(`/api/v1/action-approvals/${c.approvalId}`)).status).toBe(401);
    expect((await h.api.get(`/api/v1/action-approvals/${c.approvalId}`).set('Authorization', auth('00'.repeat(32)))).status).toBe(401);
    expect((await h.api.post(`/api/v1/action-approvals/${c.approvalId}/approve`).set('Authorization', auth(c.requesterToken)).send({ address: bob.address, signature })).status).toBe(401);
    expect((await h.api.post(`/api/v1/action-approvals/${c.approvalId}/approve`).set('Authorization', auth(browserToken(c))).send({ address: bob.address, signature })).status).toBe(400);
    expect((await h.api.post(`/api/v1/action-approvals/${c.approvalId}/consume`).set('Authorization', auth(browserToken(c))).send(body)).status).toBe(401);
    expect((await h.api.get(`/api/v1/action-approvals/${c.approvalId}`).set('Authorization', auth(c.requesterToken))).body.status).toBe('pending');
  });

  it('rejects altered message signatures and mismatched consume bindings', async () => {
    const h = await harness(); const c = await create(h);
    const bad = await alice.signTypedData(action.domain, action.types, { ...action.message, amount: '1' });
    expect((await h.api.post(`/api/v1/action-approvals/${c.approvalId}/approve`).set('Authorization', auth(browserToken(c))).send({ address: alice.address, signature: bad })).status).toBe(400);
    await approve(h, c);
    for (const changed of [{ ...body, scope: 'other' }, { ...body, circuit: 'arc_eligibility' }, { ...body, action: { ...action, message: { ...action.message, amount: '1' } } }]) {
      expect((await h.api.post(`/api/v1/action-approvals/${c.approvalId}/consume`).set('Authorization', auth(c.requesterToken)).send(changed)).status).toBe(409);
    }
    expect((await h.api.post(`/api/v1/action-approvals/${c.approvalId}/consume`).set('Authorization', auth(c.requesterToken)).send(body)).status).toBe(200);
  });

  it('allows rejection only once and never permits a rejected request to be approved', async () => {
    const h = await harness(); const c = await create(h);
    const reject = () => h.api.post(`/api/v1/action-approvals/${c.approvalId}/reject`).set('Authorization', auth(browserToken(c))).send({});
    expect((await reject()).body.status).toBe('rejected');
    expect((await reject()).status).toBe(409);
    const signature = await alice.signTypedData(action.domain, action.types, action.message);
    expect((await h.api.post(`/api/v1/action-approvals/${c.approvalId}/approve`).set('Authorization', auth(browserToken(c))).send({ address: alice.address, signature })).status).toBe(409);
  });

  it('rejects hostile origins, ignores Host for approval links, and exposes only optional public wallet config', async () => {
    const h = await harness();
    expect((await h.api.post('/api/v1/action-approvals').set('Origin', 'https://attacker.example').send(body)).status).toBe(403);
    const response = await h.api.post('/api/v1/action-approvals').set('Host', 'attacker.example').set('Origin', h.origin).send(body);
    expect(new URL(response.body.approvalUrl).origin).toBe(h.origin);
    expect(response.headers['access-control-allow-origin']).toBe(h.origin);
    expect((await h.api.get('/api/v1/action-approvals/config')).body).toEqual({});
    expect((await h.api.post('/api/v1/action-approvals').send({ ...body, action: { ...action, message: { ...action.message, memo: 'a'.repeat(33_000) } } })).status).toBe(413);
  });

  it('limits creation to ten requests per minute without silently accepting the eleventh', async () => {
    const h = await harness();
    for (let i = 0; i < 10; i++) await create(h);
    const limited = await h.api.post('/api/v1/action-approvals').set('X-Forwarded-For', '203.0.113.9').send(body);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it.each(['pending', 'approved'])('expires %s sessions without extending TTL and keeps a signature-free tombstone', async state => {
    const h = await harness(); const c = await create(h);
    const key = `action-approval:v1:${createHash('sha256').update(h.origin).digest('hex')}:${c.approvalId}`;
    const initial = await redis.eval("return {redis.call('GET', KEYS[1]), redis.call('PTTL', KEYS[1])}", 1, key);
    const record = JSON.parse(initial[0]);
    expect(record.expiresAt - record.createdAt).toBe(600_000);
    expect(initial[1]).toBeGreaterThan(890_000);
    expect(initial[0]).not.toContain(browserToken(c)); expect(initial[0]).not.toContain(c.requesterToken);
    if (state === 'approved') await approve(h, c);
    // Move only the fixture's deadline into the past; production still reads
    // real Redis TIME and executes the real atomic expiry/tombstone logic.
    await redis.eval("local s=cjson.decode(redis.call('GET',KEYS[1])); local t=redis.call('TIME'); s.expiresAt=tonumber(t[1])*1000-1; redis.call('SET',KEYS[1],cjson.encode(s),'KEEPTTL'); return 1", 1, key);
    const expired = await h.api.get(`/api/v1/action-approvals/${c.approvalId}`).set('Authorization', auth(c.requesterToken));
    expect(expired.body.status).toBe('expired');
    expect(expired.body).not.toHaveProperty('signature');
    const after = await redis.eval("return {redis.call('GET', KEYS[1]), redis.call('PTTL', KEYS[1])}", 1, key);
    expect(JSON.parse(after[0])).not.toHaveProperty('signature');
    expect(after[1]).toBeLessThan(initial[1]); expect(after[1]).toBeGreaterThan(0);
    const signature = await alice.signTypedData(action.domain, action.types, action.message);
    expect((await h.api.post(`/api/v1/action-approvals/${c.approvalId}/approve`).set('Authorization', auth(browserToken(c))).send({ address: alice.address, signature })).status).toBe(410);
    expect((await h.api.post(`/api/v1/action-approvals/${c.approvalId}/consume`).set('Authorization', auth(c.requesterToken)).send(body)).status).toBe(410);
  });

  it('accepts at most one of concurrent approval and rejection callbacks', async () => {
    const h = await harness(); const c = await create(h);
    const signature = await alice.signTypedData(action.domain, action.types, action.message);
    const responses = await Promise.all([
      h.api.post(`/api/v1/action-approvals/${c.approvalId}/approve`).set('Authorization', auth(browserToken(c))).send({ address: alice.address, signature }),
      h.api.post(`/api/v1/action-approvals/${c.approvalId}/reject`).set('Authorization', auth(browserToken(c))).send({}),
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  });

  it('preserves empty arrays and exact decimal strings through Redis JSON transitions', async () => {
    const h = await harness();
    const empty = { ...action, types: { Action: [{ name: 'values', type: 'uint256[]' }, { name: 'memo', type: 'string' }] }, message: { values: [], memo: '0' } };
    const c = await create(h, { action: empty });
    const signature = await alice.signTypedData(empty.domain, empty.types, empty.message);
    const approved = await h.api.post(`/api/v1/action-approvals/${c.approvalId}/approve`).set('Authorization', auth(browserToken(c))).send({ address: alice.address, signature });
    expect(approved.status).toBe(200); expect(approved.body.action).toEqual(empty);
    const consumed = await h.api.post(`/api/v1/action-approvals/${c.approvalId}/consume`).set('Authorization', auth(c.requesterToken)).send({ ...body, action: empty });
    expect(consumed.status).toBe(200); expect(consumed.body.action).toEqual(empty);
  });

  it('uses only the configured trusted hop for rate limits and keeps outer application proxy trust disabled', async () => {
    const h = await harness(1);
    h.app.get('/test-ip', (req, res) => res.json({ ip: req.ip }));
    for (let i = 0; i < 10; i++) expect((await h.api.post('/api/v1/action-approvals').set('X-Forwarded-For', '203.0.113.10').send(body)).status).toBe(201);
    expect((await h.api.post('/api/v1/action-approvals').set('X-Forwarded-For', '198.51.100.99, 203.0.113.10').send(body)).status).toBe(429);
    expect((await h.api.post('/api/v1/action-approvals').set('X-Forwarded-For', '203.0.113.11').send(body)).status).toBe(201);
    const outside = await h.api.get('/test-ip').set('X-Forwarded-For', '203.0.113.11');
    expect(outside.body.ip).not.toBe('203.0.113.11');
  });
});
