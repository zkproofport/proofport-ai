import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkProductionReadiness } from '../scripts/check-npm-release-readiness.mjs';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const health = (version = '0.3.0') => ({ service: 'proofport-ai', status: 'healthy', version });

describe('npm release production readiness', () => {
  it.each(['0.3.0', '0.3.1', '0.10.0', '1.0.0'])('allows an equal or newer production version (%s)', async version => {
    const requests: { url: string; options: RequestInit }[] = [];
    const result = await checkProductionReadiness('0.3.0', { fetcher: async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      return url.endsWith('/health') ? json(health(version)) : json({});
    } });
    expect(result).toEqual({ version, expectedVersion: '0.3.0' });
    expect(requests.map(request => request.url)).toEqual([
      'https://ai.zkproofport.app/health',
      'https://ai.zkproofport.app/api/v1/action-approvals/config',
    ]);
    for (const { options } of requests) {
      expect(options.method).toBe('GET');
      expect(options.redirect).toBe('error');
      expect(options.cache).toBe('no-store');
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.body).toBeUndefined();
      expect(options.headers).toEqual({ accept: 'application/json' });
    }
  });

  it.each(['0.2.17', '0.3.0-beta.1', '0.03.0', '3', '', undefined])('blocks old, prerelease or invalid production versions (%s)', async version => {
    const requests: string[] = [];
    await expect(checkProductionReadiness('0.3.0', { fetcher: async (url: string) => {
      requests.push(url); return json({ ...health(), version });
    } })).rejects.toThrow(/production.*version/i);
    expect(requests).toEqual(['https://ai.zkproofport.app/health']);
  });

  it.each([
    { service: 'another-service', status: 'healthy', version: '0.3.0' },
    { service: 'proofport-ai', status: 'degraded', version: '0.3.0' },
    null,
  ])('blocks unhealthy or unrelated services', async body => {
    await expect(checkProductionReadiness('0.3.0', { fetcher: async () => json(body) }))
      .rejects.toThrow(/production health/i);
  });

  it.each([
    () => json({ error: 'not found' }, 404),
    () => new Response('<html>old site</html>', { headers: { 'content-type': 'text/html' } }),
    () => json(null),
    () => json([]),
    () => json({ walletConnectProjectId: false }),
  ])('requires the actual approval configuration JSON endpoint', async response => {
    await expect(checkProductionReadiness('0.3.0', { fetcher: async (url: string) =>
      url.endsWith('/health') ? json(health()) : response(),
    })).rejects.toThrow(/approval configuration/i);
  });

  it('accepts the optional public WalletConnect configuration', async () => {
    await expect(checkProductionReadiness('0.3.0', { fetcher: async (url: string) =>
      url.endsWith('/health') ? json(health()) : json({ walletConnectProjectId: 'ab'.repeat(16) }),
    })).resolves.toEqual({ version: '0.3.0', expectedVersion: '0.3.0' });
  });

  it('does not echo provider failures or response bodies in publication errors', async () => {
    for (const fetcher of [
      async () => { throw new Error('provider-private-detail'); },
      async () => json({ private: 'provider-private-detail' }, 503),
    ]) {
      let message = '';
      try { await checkProductionReadiness('0.3.0', { fetcher }); }
      catch (error) { message = (error as Error).message; }
      expect(message).toMatch(/production health/i);
      expect(message).not.toContain('provider-private-detail');
    }
  });

  it('bounds a stalled request and aborts it without a retry', async () => {
    let calls = 0;
    await expect(checkProductionReadiness('0.3.0', { timeoutMs: 20, fetcher: async (_url: string, options: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(new Error('private timeout detail')), { once: true });
      });
    } })).rejects.toThrow(/production health/i);
    expect(calls).toBe(1);
  });

  it('rejects an invalid release version before any production request', async () => {
    let requested = false;
    await expect(checkProductionReadiness('latest', { fetcher: async () => {
      requested = true; return json(health());
    } })).rejects.toThrow(/release version/i);
    expect(requested).toBe(false);
  });

  it.each([true, false])('CLI gates publication using the checked-out manifest and fixed production origin (ready=%s)', ready => {
    const rootVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    // The preload replaces only network transport in a real CLI process. An
    // unexpected URL fails instead of contacting any service.
    const preload = `globalThis.fetch = async url => {
      if (url === 'https://ai.zkproofport.app/health') return Response.json(${JSON.stringify(health(ready ? rootVersion : '0.0.0'))});
      if (url === 'https://ai.zkproofport.app/api/v1/action-approvals/config') return Response.json({});
      throw new Error('unexpected request');
    };`;
    const result = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(new URL('../scripts/check-npm-release-readiness.mjs', import.meta.url)),
    ], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PROOFPORT_URL: 'https://untrusted.example' } });
    expect(result.status).toBe(ready ? 0 : 1);
    if (ready) expect(result.stdout).toContain(`server release ${rootVersion}`);
    else {
      expect(result.stderr).toContain('npm publication blocked');
      expect(result.stderr).toContain('rerun Publish to npm for the existing release tag');
    }
  });
});
