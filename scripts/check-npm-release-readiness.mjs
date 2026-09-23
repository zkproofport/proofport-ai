#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const productionOrigin = 'https://ai.zkproofport.app';

// Only stable release versions establish production readiness. In particular,
// 0.3.0-beta.1 must not satisfy the production floor 0.3.0.
function stableVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) return null;
  return value.split('+')[0].split('.').map(BigInt);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read-only gate: no configurable origin, credentials, approval creation or payment. */
export async function checkProductionReadiness(expectedVersion, { fetcher = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const expected = stableVersion(expectedVersion);
  if (!expected) throw new Error('The checked-out server release version must be a stable semantic version.');

  async function getJson(path, label) {
    try {
      const response = await fetcher(`${productionOrigin}${path}`, {
        method: 'GET', headers: { accept: 'application/json' },
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) throw new Error();
      return await response.json();
    } catch {
      throw new Error(`${label} is unavailable or did not return valid JSON.`);
    }
  }

  const health = await getJson('/health', 'Production health');
  if (!object(health) || health.service !== 'proofport-ai' || health.status !== 'healthy') {
    throw new Error('Production health does not identify a healthy proofport-ai service.');
  }
  const current = stableVersion(health.version);
  const different = current?.findIndex((part, index) => part !== expected[index]);
  if (!current || (different !== -1 && current[different] < expected[different])) {
    throw new Error(`Production server version must be at least ${expectedVersion}.`);
  }

  const config = await getJson('/api/v1/action-approvals/config', 'Production approval configuration');
  if (!object(config) || ('walletConnectProjectId' in config &&
      (typeof config.walletConnectProjectId !== 'string' || !config.walletConnectProjectId.trim()))) {
    throw new Error('Production approval configuration is invalid.');
  }
  // An empty configuration supports injected browser wallets without WalletConnect.
  return { version: health.version, expectedVersion };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('The production release readiness check accepts no overrides.');
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const result = await checkProductionReadiness(manifest.version);
    console.log(`Production proofport-ai ${result.version} is ready for server release ${result.expectedVersion} clients.`);
  } catch (error) {
    console.error(`npm publication blocked: ${error.message}`);
    console.error('Deploy the matching server release to production, verify its approval flow, then rerun Publish to npm for the existing release tag.');
    process.exitCode = 1;
  }
}
