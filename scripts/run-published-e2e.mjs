#!/usr/bin/env node
/** Install registry artifacts outside the workspace and run real SDK/MCP E2E.
 * E2E_BASE_URL must name the target. Tests can spend testnet USDC.
 * No credentials are copied into the temporary installation.
 * Usage: E2E_BASE_URL=https://stg-ai.zkproofport.app node scripts/run-published-e2e.mjs
 * Override release versions with --sdk-version / --mcp-version. Remaining
 * arguments go to Vitest, e.g. -t 'should list all 5 circuits' for a free check.
 */
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { publishedWalletDependencies, walletImportPreflight } from './published-wallet-dependencies.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
// Circle rejects older CLI wallet operations. Pin the supported version here
// so an operator's global installation cannot silently break Arc E2E.
const circleCliVersion = '1.1.4';
const sdkManifest = JSON.parse(await readFile(join(root, 'packages/sdk/package.json'), 'utf8'));
const rootLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const walletDependencies = publishedWalletDependencies(rootLock, sdkManifest);
let sdkVersion = sdkManifest.version;
let mcpVersion = JSON.parse(await readFile(join(root, 'packages/mcp/package.json'), 'utf8')).version;
const extra = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sdk-version') sdkVersion = args[++i];
  else if (args[i] === '--mcp-version') mcpVersion = args[++i];
  else extra.push(args[i]);
}
for (const [name, version] of [['sdk', sdkVersion], ['mcp', mcpVersion]]) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error(`--${name}-version requires an exact version`);
}
if (!process.env.E2E_BASE_URL) throw new Error('Set E2E_BASE_URL explicitly for published-package E2E');
const target = new URL(process.env.E2E_BASE_URL);
if (!['http:', 'https:'].includes(target.protocol)) throw new Error('E2E_BASE_URL must be HTTP(S)');
function run(command, argv, cwd, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, argv, { cwd, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => signal ? reject(new Error(`${command} terminated by ${signal}`)) : resolveRun(code ?? 1));
  });
}
const install = await mkdtemp(join(tmpdir(), 'proofport-ai-published-e2e-'));
try {
  await writeFile(join(install, 'package.json'), JSON.stringify({
    private: true, type: 'module',
    dependencies: { '@zkproofport-ai/sdk': sdkVersion, '@zkproofport-ai/mcp': mcpVersion, '@circle-fin/cli': circleCliVersion, ...walletDependencies },
    overrides: { '@zkproofport-ai/sdk': sdkVersion },
  }, null, 2));
  const status = await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], install);
  if (status) throw new Error(`Published package install failed (${status})`);
  for (const [name, version] of Object.entries(walletDependencies)) {
    const manifest = JSON.parse(await readFile(join(install, 'node_modules', name, 'package.json'), 'utf8'));
    if (manifest.version !== version) throw new Error(`${name} wallet dependency version mismatch`);
    console.log(`[published E2E] ${name}@${version}`);
  }
  const preflightStatus = await run(process.execPath, ['--input-type=module', '--eval', walletImportPreflight], install);
  if (preflightStatus) throw new Error('Optional wallet adapter import preflight failed before proof tests');
  const entries = {};
  for (const [name, version] of [['sdk', sdkVersion], ['mcp', mcpVersion]]) {
    const packageRoot = await realpath(join(install, 'node_modules', '@zkproofport-ai', name));
    if (!packageRoot.startsWith(await realpath(install) + '/')) throw new Error(`${name} resolves outside isolated installation`);
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.version !== version) throw new Error(`${name} version mismatch: ${manifest.version} != ${version}`);
    entries[name] = join(packageRoot, 'dist/index.js');
    await readFile(entries[name]); // Missing published dist must fail before tests.
    console.log(`[published E2E] ${manifest.name}@${version}: ${entries[name]}`);
  }
  const circleRoot = await realpath(join(install, 'node_modules', '@circle-fin', 'cli'));
  if (!circleRoot.startsWith(await realpath(install) + '/')) throw new Error('Circle CLI resolves outside isolated installation');
  const circleManifest = JSON.parse(await readFile(join(circleRoot, 'package.json'), 'utf8'));
  if (circleManifest.version !== circleCliVersion) throw new Error('Circle CLI version does not match the supported pin');
  const circleBin = typeof circleManifest.bin === 'string' ? circleManifest.bin : circleManifest.bin?.circle;
  if (!circleBin) throw new Error('Published Circle CLI has no circle executable');
  const circleEntry = await realpath(join(circleRoot, circleBin));
  const childEnv = { ...process.env, PATH: join(install, 'node_modules', '.bin') + delimiter + (process.env.PATH || ''),
    E2E_PUBLISHED_SDK_ENTRY: entries.sdk, E2E_MCP_ENTRY: entries.mcp };
  const { stdout: cliVersion } = await promisify(execFile)(process.execPath, [circleEntry, '--version'], { cwd: install, env: childEnv });
  if (!cliVersion.trim().split(/\s+/).includes(circleCliVersion)) throw new Error('Circle CLI executable reported an unexpected version');
  console.log(`[published E2E] @circle-fin/cli@${circleCliVersion} (isolated executable verified)`);
  console.log(`[published E2E] target: ${target.href}`);
  process.exitCode = await run(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.published.config.ts', '--project', 'e2e',
    'tests/e2e/sdk-client.test.ts', 'tests/e2e/mcp-client.test.ts',
    'tests/e2e/actionProofs.test.ts', 'tests/e2e/mcpActionPreparation.test.ts', 'tests/e2e/payment.test.ts', ...extra,
  ], root, childEnv);
} finally {
  await rm(install, { recursive: true, force: true });
}
