// Simulated-wallet browser coverage. This does not exercise a real wallet or paid proof.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
const publicRoot = fileURLToPath(new URL('../../../public/approval/', import.meta.url));
const artifactDir = process.env.APPROVAL_SCREENSHOT_DIR || join(tmpdir(), 'proofport-approval-browser');
const address = `0x${'a'.repeat(40)}`;
const token = 'simulated-browser-capability';
let browser;
before(async () => { await readFile(join(publicRoot, 'index.html')); browser = await chromium.launch({ headless: true }); await mkdir(artifactDir, { recursive: true }); });
after(async () => { await browser?.close(); });
function session(status = 'pending') {
    return { approvalId: 'demo', status, expiresAt: new Date(Date.now() + 600000).toISOString(), circuit: 'giwa_attestation', scope: 'app.example / access', expectedSigner: address,
        action: { domain: { name: 'Example application', version: '1', chainId: 91337, verifyingContract: `0x${'1'.repeat(40)}` }, primaryType: 'AccessRequest', types: { AccessRequest: [{ name: 'note', type: 'string' }, { name: 'amount', type: 'uint256' }, { name: 'enabled', type: 'bool' }, { name: 'items', type: 'Item[]' }], Item: [{ name: 'value', type: 'uint256' }] }, message: { note: '<img src=x onerror="window.xss=true"> Review these exact terms', amount: '0', enabled: false, items: [{ value: '9007199254740993123456789' }] } } };
}
async function fixture({ behavior = 'success', status = 'pending', presentation = false, mobileRecovery = false, expiresIn = 600000, viewport = { width: 1280, height: 1050 } } = {}) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const posts = [];
    const headers = [];
    const failures = [];
    page.setDefaultTimeout(8000);
    page.on('requestfailed', request => failures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
    let current = session(status);
    current.expiresAt = new Date(Date.now() + expiresIn).toISOString();
    if (presentation)
        current = { ...current, scope: 'community.proofport.app/topics', action: { domain: { ...current.action.domain, name: 'Proofport Community', chainId: 91342 }, primaryType: 'TopicPermission', types: { TopicPermission: [{ name: 'topic', type: 'string' }, { name: 'permissions', type: 'Permissions' }, { name: 'nonce', type: 'uint256' }], Permissions: [{ name: 'read', type: 'bool' }, { name: 'write', type: 'bool' }] }, message: { topic: 'research / protocol-updates', permissions: { read: true, write: false }, nonce: '0' } } };
    await page.addInitScript(({ address, behavior, chainId, mobileRecovery }) => {
        window.walletCalls = [];
        const listeners = {};
        let accounts = [address];
        const provider = { on: (e, f) => { (listeners[e] ??= []).push(f); }, removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter(x => x !== f); }, request: async ({ method, params }) => {
                window.walletCalls.push({ method, params });
                if (method === 'eth_accounts' || method === 'eth_requestAccounts')
                    return accounts;
                if (method === 'eth_chainId')
                    return `0x${chainId.toString(16)}`;
                if (method === 'eth_signTypedData_v4') {
                    if (behavior === 'held-sign')
                        return new Promise((_resolve, reject) => { window.releaseSignature = () => reject(Object.assign(new Error('declined'), { code: 4001 })); });
                    if (behavior === 'reject')
                        throw Object.assign(new Error('declined'), { code: 4001 });
                    if (behavior === 'account-change') {
                        accounts = [`0x${'b'.repeat(40)}`];
                        (listeners.accountsChanged || []).forEach(f => f(accounts));
                    }
                    return `0x${'1'.repeat(130)}`;
                }
                throw Object.assign(new Error('unsupported'), { code: 4200 });
            } };
        if (mobileRecovery) {
            window.mobileFixture = { connectCalls: 0, resetCalls: 0 };
            window.mobileFixtureProvider = provider;
            window.mobileListenerCount = () => Object.values(listeners).reduce((total, entries) => total + entries.length, 0);
        }
        const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test-wallet', name: 'Simulated EVM wallet', icon: 'data:image/svg+xml,<svg onload="alert(1)"/>', rdns: 'test.wallet' }, provider } }));
        window.addEventListener('eip6963:requestProvider', announce);
    }, { address, behavior, chainId: current.action.domain.chainId, mobileRecovery });
    await page.route('**/*', async (route) => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== 'https://approval.test')
            return route.abort();
        // Simulate only the mobile-wallet transport boundary; render the actual
        // built review UI and exercise its listeners, busy state and recovery.
        if (mobileRecovery && /^\/approval\/assets\/walletconnect-[^/]+\.js$/.test(url.pathname))
            return route.fulfill({ contentType: 'text/javascript', body: `
                export async function mobileWallet() {
                    window.mobileFixture.connectCalls++;
                    if (window.mobileFixture.connectCalls === 1) throw new Error('Simulated connection failure');
                    return window.mobileFixtureProvider;
                }
                export async function resetMobileWallet() {
                    window.mobileFixture.resetCalls++;
                    await new Promise(resolve => { window.finishMobileReset = resolve; });
                }
            ` });
        if (url.pathname.startsWith('/api/v1/action-approvals/')) {
            if (url.pathname.endsWith('/config'))
                return route.fulfill({ json: mobileRecovery ? { walletConnectProjectId: 'offline-browser-fixture' } : {} });
            headers.push(request.headers());
            if (request.method() === 'POST') {
                posts.push({ path: url.pathname, body: request.postDataJSON() });
                current = { ...current, status: url.pathname.endsWith('/reject') ? 'rejected' : 'approved' };
            }
            return route.fulfill({ json: current });
        }
        const relative = url.pathname.startsWith('/approval/') ? url.pathname.slice('/approval/'.length) : 'index.html';
        const path = resolve(publicRoot, relative);
        if (!path.startsWith(resolve(publicRoot) + '/'))
            return route.abort();
        try {
            return route.fulfill({ body: await readFile(path), contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream' });
        }
        catch {
            return route.abort();
        }
    });
    await page.goto(`https://approval.test/approve/demo#${token}`);
    return { page, context, posts, headers, failures };
}
test('rich request cards render escaped nested fields and desktop/mobile screenshots', async () => {
    const f = await fixture();
    try {
        await f.page.getByRole('heading', { name: 'Review proof request' }).waitFor();
        assert.match(await f.page.locator('body').innerText(), /AccessRequest/, JSON.stringify(f.failures));
        assert.match(await f.page.locator('body').innerText(), /Chain 91337/);
        assert.equal(await f.page.locator('img').count(), 0);
        assert.equal(await f.page.evaluate(() => window.xss), undefined);
        await f.page.locator('summary').filter({ hasText: 'AccessRequest' }).click();
        await f.page.getByText('items', { exact: true }).click();
        await f.page.getByText('[0]', { exact: true }).click();
        assert.match(await f.page.locator('body').innerText(), /9007199254740993123456789/);
        assert.equal(new URL(f.page.url()).hash, '');
        assert.ok(f.headers.every(h => h.authorization === `Bearer ${token}`));
        await f.page.screenshot({ path: join(artifactDir, 'approval-desktop.png'), fullPage: true });
        await f.page.setViewportSize({ width: 360, height: 800 });
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await f.page.screenshot({ path: join(artifactDir, 'approval-mobile.png'), fullPage: true });
        await f.page.reload();
        await f.page.getByRole('heading', { name: 'Review proof request' }).waitFor();
        assert.ok(f.headers.every(h => h.authorization === `Bearer ${token}`));
    }
    finally {
        await f.context.close();
    }
});
test('app-style clean request identifies the provided name and expands exact action fields', async () => {
    const f = await fixture({ presentation: true });
    try {
        await f.page.getByRole('heading', { name: 'Proofport Community', exact: true }).waitFor();
        assert.match(await f.page.locator('body').innerText(), /GIWA KYC/);
        assert.match(await f.page.locator('body').innerText(), /Chain 91342/);
        assert.match(await f.page.locator('body').innerText(), /Expected signing wallet/);
        const summary = f.page.locator('summary').filter({ hasText: 'TopicPermission' });
        assert.equal(await summary.evaluate(element => element.parentElement.open), false);
        await f.page.screenshot({ path: join(artifactDir, 'approval-review-desktop.png'), fullPage: true });
        await f.page.setViewportSize({ width: 360, height: 800 });
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await f.page.screenshot({ path: join(artifactDir, 'approval-review-mobile.png'), fullPage: true });
        await summary.click();
        await f.page.getByText('permissions', { exact: true }).click();
        assert.match(await f.page.locator('body').innerText(), /research \/ protocol-updates/);
        assert.match(await f.page.locator('body').innerText(), /false/);
        await f.page.screenshot({ path: join(artifactDir, 'approval-review-mobile-expanded.png'), fullPage: true });
        await f.page.setViewportSize({ width: 1280, height: 1050 });
        await f.page.screenshot({ path: join(artifactDir, 'approval-review-expanded.png'), fullPage: true });
    }
    finally {
        await f.context.close();
    }
});
test('explicit selection then review/sign approves the exact action', async () => {
    const f = await fixture();
    try {
        await f.page.getByRole('button', { name: 'Simulated EVM wallet', exact: true }).click();
        await f.page.getByRole('button', { name: 'Review and sign', exact: true }).click();
        await f.page.getByRole('heading', { name: 'Approval complete', exact: true }).waitFor();
        assert.equal(f.posts.length, 1);
        assert.equal(f.posts[0].body.address, address);
        const payload = await f.page.evaluate(() => JSON.parse(window.walletCalls.find(c => c.method === 'eth_signTypedData_v4').params[1]));
        assert.equal(payload.domain.chainId, 91337);
        assert.equal(payload.message.amount, '0');
    }
    finally {
        await f.context.close();
    }
});
for (const behavior of ['reject', 'account-change'])
    test(`simulated wallet ${behavior} never submits approval`, async () => {
        const f = await fixture({ behavior });
        try {
            await f.page.getByRole('button', { name: 'Simulated EVM wallet', exact: true }).click();
            await f.page.getByRole('button', { name: 'Review and sign', exact: true }).click();
            await f.page.getByRole('alert').waitFor();
            assert.equal(f.posts.length, 0);
        }
        finally {
            await f.context.close();
        }
    });
test('reject works without wallet and optional mobile configuration is explicit', async () => {
    const f = await fixture();
    try {
        await f.page.getByText('Mobile wallet connection is not configured. Use an available browser wallet.').waitFor();
        await f.page.getByRole('button', { name: 'Reject request', exact: true }).click();
        await f.page.getByRole('heading', { name: 'Request rejected', exact: true }).waitFor();
        assert.equal(f.posts.length, 1);
        assert.ok(f.posts[0].path.endsWith('/reject'));
        assert.deepEqual(await f.page.evaluate(() => window.walletCalls), []);
    }
    finally {
        await f.context.close();
    }
});
test('mobile recovery resets without automatic pairing and removes connected-wallet listeners', async () => {
    const f = await fixture({ mobileRecovery: true, behavior: 'held-sign' });
    try {
        const connect = f.page.getByRole('button', { name: 'Connect mobile wallet', exact: true });
        await connect.click();
        await f.page.getByRole('alert').waitFor();
        const reset = f.page.getByRole('button', { name: 'Reset mobile connection', exact: true });
        await reset.click();
        await f.page.waitForFunction(() => window.mobileFixture.resetCalls === 1);
        assert.equal(await connect.isDisabled(), true);
        assert.equal(await reset.isDisabled(), true);
        await f.page.evaluate(() => window.finishMobileReset());
        await f.page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Connect mobile wallet').disabled);
        assert.deepEqual(await f.page.evaluate(() => window.mobileFixture), { connectCalls: 1, resetCalls: 1 });
        await connect.click();
        const disconnect = f.page.getByRole('button', { name: 'Disconnect mobile wallet', exact: true });
        await disconnect.waitFor();
        assert.equal(await f.page.evaluate(() => window.mobileListenerCount()), 3);
        const sign = f.page.getByRole('button', { name: 'Review and sign', exact: true });
        assert.equal(await sign.isDisabled(), false);
        await sign.click();
        await f.page.waitForFunction(() => typeof window.releaseSignature === 'function');
        assert.equal(await disconnect.isDisabled(), true);
        await f.page.evaluate(() => window.releaseSignature());
        await f.page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Disconnect mobile wallet').disabled);
        await disconnect.click();
        await f.page.waitForFunction(() => window.mobileFixture.resetCalls === 2);
        assert.equal(await f.page.getByRole('heading', { name: 'Connected wallet', exact: true }).count(), 0);
        assert.equal(await f.page.evaluate(() => window.mobileListenerCount()), 0);
        assert.equal(await f.page.getByRole('button', { name: 'Review and sign', exact: true }).isDisabled(), true);
        assert.equal(await connect.isDisabled(), true);
        await f.page.evaluate(() => window.finishMobileReset());
        await f.page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Connect mobile wallet').disabled);
        assert.deepEqual(await f.page.evaluate(() => window.mobileFixture), { connectCalls: 2, resetCalls: 2 });
        await connect.click();
        await disconnect.waitFor();
        assert.deepEqual(await f.page.evaluate(() => window.mobileFixture), { connectCalls: 3, resetCalls: 2 });
        assert.equal(f.posts.length, 0);
    }
    finally { await f.context.close(); }
});
test('status polling preserves keyboard focus while the request is unchanged', async () => {
    const f = await fixture();
    try {
        const walletButton = f.page.getByRole('button', { name: 'Simulated EVM wallet', exact: true });
        await walletButton.focus();
        const refreshed = f.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/action-approvals/demo');
        await (await refreshed).finished();
        await f.page.waitForTimeout(50);
        assert.equal(await walletButton.evaluate(element => document.activeElement === element), true);
    }
    finally {
        await f.context.close();
    }
});
test('local expiry removes signing controls without duplicating review cards', async () => {
    const f = await fixture({ expiresIn: 1500 });
    try {
        await f.page.getByRole('heading', { name: 'Request expired', exact: true }).first().waitFor();
        assert.equal(await f.page.getByRole('heading', { name: 'Request details', exact: true }).count(), 1);
        assert.equal(await f.page.getByRole('button', { name: 'Review and sign', exact: true }).count(), 0);
        assert.equal(f.posts.length, 0);
    } finally { await f.context.close(); }
});
for (const status of ['approved', 'rejected', 'consumed', 'expired'])
    test(`server ${status} prevents signing`, async () => {
        const f = await fixture({ status });
        try {
            await f.page.getByRole('heading', { name: 'Review proof request' }).waitFor();
            assert.equal(await f.page.getByRole('button', { name: 'Review and sign', exact: true }).count(), 0);
            assert.equal(f.posts.length, 0);
        }
        finally {
            await f.context.close();
        }
    });
