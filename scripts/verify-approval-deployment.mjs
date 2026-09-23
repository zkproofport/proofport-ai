#!/usr/bin/env node
// Opt-in deployed HTTP smoke. Requires Node 20.19+ and the repository's ethers
// dependency. Uses a PUBLIC deterministic fixture key, never an operator wallet.
// It creates approval sessions only: no proof, challenge, payment, RPC or transaction.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';

const HOSTS = new Set(['stg-ai.zkproofport.app', 'ai.zkproofport.app']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
class SmokeFailure extends Error {
  constructor(code, details) { super(code); this.code = code; this.details = details; }
}
const requireThat = (condition, code, details) => { if (!condition) throw new SmokeFailure(code, details); };
function releaseOrigin(input) {
  let url;
  try { url = new URL(input); } catch { throw new SmokeFailure('invalid_release_origin'); }
  requireThat(url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'release_origin_not_allowed');
  return url.origin;
}
export function parseOptions(args) {
  const flags = new Map([
    ['--base-url', 'baseUrl'], ['--expected-version', 'expectedVersion'],
    ['--expected-assets-dir', 'expectedAssetsDir'], ['--expected-index-sha256', 'expectedIndexSha256'],
    ['--output', 'output'],
  ]);
  const options = { allowDeployed: false, waitForExpiry: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    requireThat(!seen.has(flag), 'duplicate_argument'); seen.add(flag);
    if (flag === '--allow-deployed') options.allowDeployed = true;
    else if (flag === '--wait-for-expiry') options.waitForExpiry = true;
    else {
      const key = flags.get(flag);
      requireThat(key && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--'), 'invalid_argument');
      options[key] = args[++i];
    }
  }
  requireThat(options.allowDeployed && options.baseUrl, 'explicit_release_opt_in_required');
  options.baseUrl = releaseOrigin(options.baseUrl);
  if (options.expectedVersion !== undefined) requireThat(/^[0-9A-Za-z.+-]{1,64}$/.test(options.expectedVersion), 'invalid_expected_version');
  if (options.expectedIndexSha256 !== undefined) requireThat(/^[0-9a-f]{64}$/.test(options.expectedIndexSha256), 'invalid_expected_digest');
  return options;
}
export function approvalRequestUrl(baseUrl, path) {
  const origin = releaseOrigin(baseUrl);
  requireThat(typeof path === 'string' && (
    path === '/health' || path === '/api/v1/action-approvals' || path === '/api/v1/action-approvals/config' ||
    /^\/api\/v1\/action-approvals\/[0-9a-f]{32}(?:\/(?:approve|reject|consume))?$/.test(path) ||
    /^\/approve\/[0-9a-f]{32}$/.test(path) ||
    /^\/approval\/assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(path)
  ), 'request_route_not_allowed');
  return origin + path;
}
function publicState(body, capabilities, signature) {
  requireThat(body && typeof body === 'object' && !Array.isArray(body), 'invalid_public_state');
  for (const key of ['signature', 'requesterToken', 'browserToken', 'requesterHash', 'browserHash', 'approvalUrl', 'requestJson']) requireThat(!Object.hasOwn(body, key), 'private_field_in_public_state');
  const serialized = JSON.stringify(body);
  requireThat(capabilities.every(token => !serialized.includes(token)) && (!signature || !serialized.includes(signature)), 'private_value_in_public_state');
}
const FIXTURE_CHAINS = { giwa_attestation: 91342, arc_eligibility: 5042002 };
function fixture(circuit) {
  requireThat(Object.hasOwn(FIXTURE_CHAINS, circuit), 'unknown_fixture_circuit');
  return {
    circuit, scope: `proofport:deployment-approval-smoke:${randomUUID()}`,
    action: {
      domain: { name: 'Public deployment approval fixture', version: '1', chainId: FIXTURE_CHAINS[circuit], verifyingContract: '0x' + '33'.repeat(20) },
      primaryType: 'Statement',
      types: { Statement: [{ name: 'text', type: 'string' }, { name: 'values', type: 'uint256[]' }, { name: 'enabled', type: 'bool' }] },
      message: { text: 'Deployment smoke only: no action execution. 한글 <script> &', values: [], enabled: false },
    },
  };
}

export async function runReleaseSmoke(options, dependencies = {}) {
  // Revalidate even when imported rather than invoked through the CLI.
  const settings = parseOptions([
    ...(options.allowDeployed ? ['--allow-deployed'] : []), '--base-url', options.baseUrl,
    ...(options.waitForExpiry ? ['--wait-for-expiry'] : []),
    ...(options.expectedVersion ? ['--expected-version', options.expectedVersion] : []),
    ...(options.expectedAssetsDir ? ['--expected-assets-dir', options.expectedAssetsDir] : []),
    ...(options.expectedIndexSha256 ? ['--expected-index-sha256', options.expectedIndexSha256] : []),
  ]);
  const fetcher = dependencies.fetcher ?? ((...args) => fetch(...args));
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const report = {
    baseUrl: settings.baseUrl, startedAt: new Date().toISOString(), success: false,
    testKind: 'deployed-approval-http-smoke-public-fixture', proofRequests: 0, paymentRequests: 0,
    cases: [], assets: [], skipped: [],
  };
  let step = 'preflight';
  const unfinished = [];
  const check = async (name, fn) => { step = name; await fn(); report.cases.push({ name, passed: true }); };
  const request = async (path, expected, { method = 'GET', body, token, origin } = {}) => {
    const url = approvalRequestUrl(settings.baseUrl, path);
    requireThat(method === 'GET' || (method === 'POST' && path.startsWith('/api/v1/action-approvals')), 'request_method_not_allowed');
    let response;
    try {
      response = await fetcher(url, {
        method, redirect: 'error', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000),
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new SmokeFailure('network_or_protocol_failure'); }
    requireThat(expected.includes(response.status), 'unexpected_http_status', { expected, actual: response.status });
    return response;
  };
  const json = async (...args) => {
    const response = await request(...args);
    try { return { response, body: await response.json() }; } catch { throw new SmokeFailure('invalid_json_response'); }
  };
  const headers = response => {
    requireThat(response.headers.get('cache-control') === 'no-store', 'missing_no_store');
    requireThat(response.headers.get('referrer-policy') === 'no-referrer', 'missing_no_referrer');
    requireThat(response.headers.get('access-control-allow-origin') !== '*', 'wildcard_approval_cors');
  };
  const alice = new Wallet('0x' + '11'.repeat(32)); // PUBLIC test key. Never funded or sent to a chain.
  const create = async circuit => {
    const payload = fixture(circuit);
    const { body, response } = await json('/api/v1/action-approvals', [201], { method: 'POST', body: { ...payload, expectedSigner: alice.address } });
    headers(response);
    requireThat(/^[0-9a-f]{32}$/.test(body.approvalId) && /^[0-9a-f]{64}$/.test(body.requesterToken) && body.status === 'pending', 'invalid_created_session');
    let url; try { url = new URL(body.approvalUrl); } catch { throw new SmokeFailure('invalid_approval_link'); }
    const browserToken = url.hash.substring(1);
    requireThat(url.origin === settings.baseUrl && url.pathname === `/approve/${body.approvalId}` && !url.search && !url.username && !url.password && /^[0-9a-f]{64}$/.test(browserToken) && browserToken !== body.requesterToken, 'invalid_approval_capability_separation');
    const expires = Date.parse(body.expiresAt);
    requireThat(Number.isFinite(expires) && expires > Date.now() + 570000 && expires < Date.now() + 630000, 'unexpected_fixed_expiry');
    const session = { path: `/api/v1/action-approvals/${body.approvalId}`, payload, browserToken, requesterToken: body.requesterToken, expiresAt: body.expiresAt, status: 'pending' };
    unfinished.push(session);
    return session;
  };
  const read = async session => {
    const { body, response } = await json(session.path, [200], { token: session.requesterToken });
    headers(response); publicState(body, [session.browserToken, session.requesterToken]);
    requireThat(body.expiresAt === session.expiresAt, 'expiry_was_extended');
    requireThat(same(body.action, session.payload.action) && body.circuit === session.payload.circuit && body.scope === session.payload.scope, 'frozen_request_mismatch');
    return body;
  };
  try {
    await check('service-health', async () => {
      const { body } = await json('/health', [200]);
      requireThat(body.status === 'healthy' && body.service === 'proofport-ai', 'service_not_healthy');
      requireThat(typeof body.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(body.version), 'invalid_service_version');
      if (settings.expectedVersion) requireThat(body.version === settings.expectedVersion, 'version_mismatch');
      report.serviceVersion = body.version;
    });
    await check('approval-page-and-assets', async () => {
      const response = await request('/approve/' + '00'.repeat(16), [200]); headers(response);
      requireThat(response.headers.get('content-security-policy')?.includes("script-src 'self'"), 'missing_script_csp');
      const html = await response.text(); const indexSha256 = digest(html); report.indexSha256 = indexSha256;
      if (settings.expectedIndexSha256) requireThat(indexSha256 === settings.expectedIndexSha256, 'index_digest_mismatch');
      if (settings.expectedAssetsDir) requireThat(indexSha256 === digest(await readFile(resolve(settings.expectedAssetsDir, 'index.html'))), 'local_index_mismatch');
      const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/approval\/assets\/[^\"]+)"/g)].map(match => match[1]))];
      requireThat(assets.some(path => path.endsWith('.js')) && assets.some(path => path.endsWith('.css')), 'missing_bundled_assets');
      for (const path of assets) {
        const asset = await request(path, [200]); const hash = digest(new Uint8Array(await asset.arrayBuffer()));
        if (settings.expectedAssetsDir) requireThat(hash === digest(await readFile(join(resolve(settings.expectedAssetsDir), path.substring('/approval/'.length)))), 'asset_digest_mismatch');
        report.assets.push({ path, sha256: hash });
      }
    });
    await check('public-config-and-origin-guard', async () => {
      const { body, response } = await json('/api/v1/action-approvals/config', [200]); headers(response);
      requireThat(Object.keys(body).every(key => key === 'walletConnectProjectId') && (body.walletConnectProjectId === undefined || typeof body.walletConnectProjectId === 'string'), 'unexpected_config_fields');
      report.walletConnectConfigured = Boolean(body.walletConnectProjectId);
      await request('/api/v1/action-approvals', [403], { method: 'POST', body: fixture('giwa_attestation'), origin: 'https://forbidden.invalid' });
    });
    let approval;
    await check('create-and-capability-auth', async () => {
      approval = await create('giwa_attestation');
      await request(approval.path, [401]);
      await request(approval.path, [401], { token: '00'.repeat(32) });
      const { body: browserRead } = await json(approval.path, [200], { token: approval.browserToken });
      publicState(browserRead, [approval.browserToken, approval.requesterToken]);
      requireThat(browserRead.status === 'pending' && (await read(approval)).status === 'pending', 'unexpected_pending_state');
      await request(approval.path + '/reject', [401], { method: 'POST', body: {}, token: approval.requesterToken });
    });
    const { action } = approval.payload;
    const signature = await alice.signTypedData(action.domain, action.types, action.message);
    await check('signature-verification-and-public-privacy', async () => {
      await request(approval.path + '/approve', [401], { method: 'POST', body: { address: alice.address, signature }, token: approval.requesterToken });
      const altered = await alice.signTypedData(action.domain, action.types, { ...action.message, text: 'An altered fixture message' });
      await request(approval.path + '/approve', [400], { method: 'POST', body: { address: alice.address, signature: altered }, token: approval.browserToken });
      const { body } = await json(approval.path + '/approve', [200], { method: 'POST', body: { address: alice.address, signature }, token: approval.browserToken });
      approval.status = 'approved'; publicState(body, [approval.browserToken, approval.requesterToken], signature);
      requireThat(body.status === 'approved' && (await read(approval)).status === 'approved', 'approval_not_recorded');
    });
    await check('binding-role-and-atomic-consume', async () => {
      await request(approval.path + '/consume', [401], { method: 'POST', body: approval.payload, token: approval.browserToken });
      await request(approval.path + '/consume', [409], { method: 'POST', body: { ...approval.payload, scope: approval.payload.scope + ':altered' }, token: approval.requesterToken });
      const responses = await Promise.all([0, 1].map(() => request(approval.path + '/consume', [200, 409], { method: 'POST', body: approval.payload, token: approval.requesterToken })));
      requireThat(same(responses.map(response => response.status).sort(), [200, 409]), 'consume_not_atomic');
      const consumed = await responses.find(response => response.status === 200).json();
      requireThat(consumed.address === alice.address && consumed.signature === signature && same(consumed.action, approval.payload.action) && consumed.scope === approval.payload.scope && consumed.circuit === approval.payload.circuit, 'consumed_fixture_mismatch');
      approval.status = 'consumed';
      requireThat((await read(approval)).status === 'consumed', 'consumed_state_missing');
      await request(approval.path + '/consume', [409], { method: 'POST', body: approval.payload, token: approval.requesterToken });
    });
    await check('reject-and-terminal-state', async () => {
      const rejected = await create('arc_eligibility');
      const { body } = await json(rejected.path + '/reject', [200], { method: 'POST', body: {}, token: rejected.browserToken });
      rejected.status = 'rejected'; publicState(body, [rejected.browserToken, rejected.requesterToken]);
      requireThat(body.status === 'rejected' && (await read(rejected)).status === 'rejected', 'rejection_not_recorded');
      await request(rejected.path + '/reject', [409], { method: 'POST', body: {}, token: rejected.browserToken });
      await request(rejected.path + '/consume', [409], { method: 'POST', body: rejected.payload, token: rejected.requesterToken });
    });
    if (settings.waitForExpiry) {
      await check('real-expiry-transition', async () => {
        const expiring = await create('giwa_attestation');
        const deadline = Date.parse(expiring.expiresAt) + 1500;
        requireThat(deadline - Date.now() <= 632000, 'expiry_wait_out_of_bounds');
        while (Date.now() < deadline) await sleep(Math.min(30000, deadline - Date.now()));
        requireThat((await read(expiring)).status === 'expired', 'expiry_transition_missing');
        expiring.status = 'expired';
        await request(expiring.path + '/reject', [410], { method: 'POST', body: {}, token: expiring.browserToken });
        await request(expiring.path + '/consume', [410], { method: 'POST', body: expiring.payload, token: expiring.requesterToken });
      });
    } else report.skipped.push({ name: 'real-expiry-transition', reason: 'Server TTL is fixed at 10 minutes. Use --wait-for-expiry to observe expiration; fixed expiry and non-extension were checked.' });
    report.success = true;
  } catch (error) {
    report.failure = { step, code: error instanceof SmokeFailure ? error.code : 'unexpected_local_or_protocol_failure', ...(error instanceof SmokeFailure && error.details ? { details: error.details } : {}) };
  } finally {
    // Only this process's pending fixture sessions are rejected. No approval,
    // consumption, proof or payment is retried after an unknown result.
    for (const session of unfinished.filter(session => session.status === 'pending')) {
      try { await request(session.path + '/reject', [200, 409, 410], { method: 'POST', body: {}, token: session.browserToken }); } catch { /* Fixed TTL bounds orphan fixture sessions. */ }
    }
    report.finishedAt = new Date().toISOString();
    report.passedCases = report.cases.length;
  }
  return report;
}

async function main() {
  let options;
  let report;
  try { options = parseOptions(process.argv.slice(2)); report = await runReleaseSmoke(options); }
  catch (error) { report = { success: false, failure: { step: 'arguments', code: error instanceof SmokeFailure ? error.code : 'invalid_arguments' } }; }
  if (options?.output) {
    try { await mkdir(dirname(resolve(options.output)), { recursive: true }); await writeFile(resolve(options.output), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
    catch { report = { ...report, success: false, artifactWriteFailed: true }; }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.success) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
