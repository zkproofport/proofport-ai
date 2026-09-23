import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Wallet } from 'ethers';

// Opt-in real-container HTTP check. It never calls a proof/payment endpoint,
// uses only a public deterministic test EOA, and is not a human-wallet E2E.
const base = process.env.APPROVAL_HTTP_BASE_URL;
describe.skipIf(!base)('approval API on the local container (APPROVAL_HTTP_BASE_URL required)', () => {
  it('serves the current bundled page and atomically consumes a real test signature without payment', async () => {
    const url = new URL(base!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('This integration check requires the explicit local container URL.');
    const alice = new Wallet('0x' + '11'.repeat(32));
    const action = {
      domain: { name: 'Local approval integration', version: '1', chainId: 84532, verifyingContract: '0x' + '33'.repeat(20) },
      primaryType: 'Statement', types: { Statement: [{ name: 'text', type: 'string' }, { name: 'values', type: 'uint256[]' }] },
      message: { text: '한글 😀 <script> % _ \\ SELECT\n\t', values: [] },
    };
    const payload = { circuit: 'giwa_attestation', scope: `approval-integration:${randomUUID()}`, action };
    const json = async (path: string, method = 'GET', body?: unknown, token?: string) => fetch(`${base}${path}`, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const created = await json('/api/v1/action-approvals', 'POST', { ...payload, expectedSigner: alice.address });
    expect(created.status).toBe(201); const session = await created.json();
    const browser = new URL(session.approvalUrl).hash.substring(1);
    const path = `/api/v1/action-approvals/${session.approvalId}`;
    expect((await json(path)).status).toBe(401);
    const page = await fetch(`${base}/approve/${session.approvalId}`);
    expect(page.status).toBe(200); expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('cache-control')).toBe('no-store'); expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await page.text(); const local = await readFile(resolve('public/approval/index.html'), 'utf8');
    expect(html).toBe(local);
    const assets = [...html.matchAll(/(?:src|href)="(\/approval\/assets\/[^\"]+)"/g)].map(match => match[1]);
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      const response = await fetch(base + asset); expect(response.status).toBe(200);
      const localBytes = await readFile(resolve('public', asset.substring(1)));
      const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
      expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(digest(localBytes));
    }
    const signature = await alice.signTypedData(action.domain, action.types, action.message);
    const approved = await json(path + '/approve', 'POST', { address: alice.address, signature }, browser);
    expect(approved.status).toBe(200); expect((await approved.json()).status).toBe('approved');
    const status = await (await json(path, 'GET', undefined, session.requesterToken)).json();
    expect(status.action).toEqual(action); expect(status).not.toHaveProperty('signature'); expect(status).not.toHaveProperty('requesterToken');
    const results = await Promise.all([json(path + '/consume', 'POST', payload, session.requesterToken), json(path + '/consume', 'POST', payload, session.requesterToken)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const consumed = await results.find(result => result.status === 200)!.json();
    expect(consumed).toEqual({ ...payload, address: alice.address, signature });
    expect((await (await json(path, 'GET', undefined, session.requesterToken)).json()).status).toBe('consumed');
  }, 30_000);
});
