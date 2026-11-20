import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CIRCUIT_DIRS } from '../src/config/circuitIds.js';
import { CIRCUITS_COMMIT, pinnedCircuitsRawBase } from '../src/config/circuitsPin.js';
import {
  checkCircuitsPin,
  checkToolchain,
  parseCircuitsStamp,
  parseToolchainEnv,
  readNoirJsVersion,
  verifyCircuitsAtBoot,
  type CircuitsStamp,
} from '../src/circuit/circuitsSource.js';
import { describeCheckout, parseCheckoutMode, stampedPaths } from '../scripts/lib/circuitsCheckout.js';

/**
 * The server proves with ONE circuits commit, pinned in src/config/circuitsPin.ts,
 * and refuses to start on artifacts from anywhere else or on a prover from
 * another toolchain. Before 2026-11-17 it read circuits `main` (artifacts,
 * staging verifiers) and `releases/latest` (production verifiers).
 */

const SRC = path.resolve(__dirname, '../src');
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const OTHER = 'a'.repeat(40);

function stamp(overrides: Partial<CircuitsStamp> = {}): CircuitsStamp {
  return { commit: CIRCUITS_COMMIT, worktree: false, nargoVersion: '1.0.0', bbVersion: '6.0.0', ...overrides };
}

function sourceFiles(directory: string): string[] {
  return fsSync.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('the pin', () => {
  it('is a full commit SHA', () => {
    expect(CIRCUITS_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(pinnedCircuitsRawBase()).toBe(`https://raw.githubusercontent.com/zkproofport/circuits/${CIRCUITS_COMMIT}`);
  });

  it('is the only circuits source in src/: no main, no releases/latest, no CIRCUITS_REPO_URL', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = fsSync.readFileSync(file, 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const pattern of [
        /zkproofport\/circuits\/main/,
        /\/circuits\/(?:main|master)\b/,
        /api\.github\.com/,
        /releases\/latest/,
        /process\.env\.CIRCUITS_REPO_URL/,
        /process\.env\[['"]CIRCUITS_REPO_URL['"]\]/,
      ]) {
        if (pattern.test(code)) offenders.push(`${path.relative(SRC, file)}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is not configuration: loadConfig has no circuits repo URL', async () => {
    const text = await fs.readFile(path.join(SRC, 'config/index.ts'), 'utf8');
    expect(text).not.toMatch(/circuitsRepoUrl\s*:/);
  });
});

describe('parseToolchainEnv', () => {
  it('reads NARGO_VERSION and BB_VERSION, ignoring comments and other keys', () => {
    expect(parseToolchainEnv('# x\nNARGO_VERSION=1.0.0\nBB_VERSION=6.0.0\nNOIR_RS_TAG=foo\n'))
      .toEqual({ nargoVersion: '1.0.0', bbVersion: '6.0.0' });
  });
  it('names a missing key instead of filling one in', () => {
    expect(() => parseToolchainEnv('NARGO_VERSION=1.0.0\n')).toThrow('toolchain.env has no BB_VERSION');
    expect(() => parseToolchainEnv('BB_VERSION=6.0.0\nNARGO_VERSION=\n')).toThrow('toolchain.env has no NARGO_VERSION');
  });
});

describe('parseCircuitsStamp', () => {
  it('accepts a complete stamp', () => {
    expect(parseCircuitsStamp(stamp())).toEqual(stamp());
  });
  it.each([
    [{ commit: 'main' }, 'commit must be a 40-hex'],
    [{ commit: 'v2.2.0' }, 'commit must be a 40-hex'],
    [{ commit: CIRCUITS_COMMIT.slice(0, 7) }, 'commit must be a 40-hex'],
    [{ worktree: 'false' }, 'worktree must be true or false'],
    [{ bbVersion: '' }, 'bbVersion is missing'],
    [{ nargoVersion: undefined }, 'nargoVersion is missing'],
  ])('refuses %j', (overrides, message) => {
    expect(() => parseCircuitsStamp({ ...stamp(), ...overrides })).toThrow(message);
  });
  it('refuses a non-object', () => {
    expect(() => parseCircuitsStamp(null)).toThrow('not a JSON object');
  });
});

describe('checkCircuitsPin', () => {
  it('accepts the pinned commit', () => {
    expect(() => checkCircuitsPin(stamp(), 'mainnet')).not.toThrow();
  });
  it('refuses artifacts from another commit, in every payment mode', () => {
    for (const mode of ['mainnet', 'testnet', 'disabled']) {
      expect(() => checkCircuitsPin(stamp({ commit: OTHER }), mode)).toThrow(`come from circuits ${OTHER}, but this server is pinned to ${CIRCUITS_COMMIT}`);
    }
  });
  it('accepts a working-tree stamp off mainnet only', () => {
    expect(() => checkCircuitsPin(stamp({ commit: OTHER, worktree: true }), 'testnet')).not.toThrow();
    expect(() => checkCircuitsPin(stamp({ worktree: true }), 'disabled')).not.toThrow();
    expect(() => checkCircuitsPin(stamp({ worktree: true }), 'mainnet')).toThrow('a mainnet server never proves with');
  });
});

describe('checkToolchain', () => {
  it('accepts the stamp\'s own bb and nargo', () => {
    expect(() => checkToolchain(stamp(), { bbVersion: '6.0.0', noirJsVersion: '1.0.0' })).not.toThrow();
  });
  it('refuses bb 6 with beta.19 artifacts, and the reverse', () => {
    const beta19 = stamp({ nargoVersion: '1.0.0-beta.19', bbVersion: '4.2.0-aztecnr-rc.2' });
    expect(() => checkToolchain(beta19, { bbVersion: '6.0.0', noirJsVersion: '1.0.0-beta.19' }))
      .toThrow('bb reports 6.0.0, but the circuits at');
    expect(() => checkToolchain(stamp(), { bbVersion: '4.2.0-aztecnr-rc.2', noirJsVersion: '1.0.0' }))
      .toThrow('were built with bb 6.0.0');
  });
  it('refuses a noir_js from another nargo', () => {
    expect(() => checkToolchain(stamp(), { bbVersion: '6.0.0', noirJsVersion: '1.0.0-beta.19' }))
      .toThrow('@noir-lang/noir_js is 1.0.0-beta.19');
  });
});

describe('verifyCircuitsAtBoot', () => {
  let directory: string;
  let noirJs: string;

  async function writeBb(version: string): Promise<string> {
    const bb = path.join(directory, 'bb');
    await fs.writeFile(bb, `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version}"\n`, { mode: 0o755 });
    return bb;
  }

  async function bake(overrides: Partial<CircuitsStamp> = {}): Promise<void> {
    const circuits = path.join(directory, 'circuits');
    const meta: Record<string, { jsonHash: string; vkHash: string }> = {};
    for (const [id, entry] of Object.entries(CIRCUIT_DIRS)) {
      const target = path.join(circuits, entry.dir, 'target');
      await fs.mkdir(path.join(target, 'vk'), { recursive: true });
      const json = Buffer.from(JSON.stringify({ noir_version: `${noirJs}+abc`, bytecode: 'AQID', abi: { parameters: [] } }));
      const vk = Buffer.from('vk');
      await fs.writeFile(path.join(target, `${entry.packageName}.json`), json);
      await fs.writeFile(path.join(target, 'vk/vk'), vk);
      meta[id] = { jsonHash: sha256(json), vkHash: sha256(vk) };
    }
    await fs.writeFile(path.join(circuits, 'artifacts-meta.json'), JSON.stringify(meta));
    await fs.writeFile(path.join(circuits, 'circuits-source.json'),
      JSON.stringify(stamp({ nargoVersion: noirJs, bbVersion: '6.0.0', ...overrides })));
  }

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'circuits-boot-'));
    noirJs = await readNoirJsVersion();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('boot must not fetch circuits'); }));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('reads the installed noir_js version', () => {
    expect(noirJs).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('boots on pinned, intact artifacts with the matching bb, and fetches nothing', async () => {
    await bake();
    const result = await verifyCircuitsAtBoot({ circuitsDir: path.join(directory, 'circuits'), bbPath: await writeBb('6.0.0'), paymentMode: 'mainnet' });
    expect(result.commit).toBe(CIRCUITS_COMMIT);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses to boot without a stamp', async () => {
    await bake();
    await fs.rm(path.join(directory, 'circuits/circuits-source.json'));
    await expect(verifyCircuitsAtBoot({ circuitsDir: path.join(directory, 'circuits'), bbPath: await writeBb('6.0.0'), paymentMode: 'testnet' }))
      .rejects.toThrow('do not say which circuits commit they came from');
  });

  it('refuses to boot on artifacts from another commit', async () => {
    await bake({ commit: OTHER });
    await expect(verifyCircuitsAtBoot({ circuitsDir: path.join(directory, 'circuits'), bbPath: await writeBb('6.0.0'), paymentMode: 'testnet' }))
      .rejects.toThrow('but this server is pinned to');
  });

  it('refuses to boot when the image\'s bb is not the artifacts\' bb', async () => {
    await bake();
    await expect(verifyCircuitsAtBoot({ circuitsDir: path.join(directory, 'circuits'), bbPath: await writeBb('4.2.0-aztecnr-rc.2'), paymentMode: 'testnet' }))
      .rejects.toThrow('bb reports 4.2.0-aztecnr-rc.2, but the circuits at');
  });

  it('refuses to boot when the stamp\'s nargo is not the installed noir_js', async () => {
    await bake({ nargoVersion: '0.0.1-other' });
    // the artifacts say the stamp's nargo too, so only the noir_js check can refuse
    for (const entry of Object.values(CIRCUIT_DIRS)) {
      const file = path.join(directory, 'circuits', entry.dir, 'target', `${entry.packageName}.json`);
      const json = Buffer.from(JSON.stringify({ noir_version: '0.0.1-other+abc', bytecode: 'AQID', abi: { parameters: [] } }));
      await fs.writeFile(file, json);
    }
    const meta = JSON.parse(await fs.readFile(path.join(directory, 'circuits/artifacts-meta.json'), 'utf8'));
    for (const [id, entry] of Object.entries(CIRCUIT_DIRS)) {
      meta[id].jsonHash = sha256(await fs.readFile(path.join(directory, 'circuits', entry.dir, 'target', `${entry.packageName}.json`)));
    }
    await fs.writeFile(path.join(directory, 'circuits/artifacts-meta.json'), JSON.stringify(meta));
    await expect(verifyCircuitsAtBoot({ circuitsDir: path.join(directory, 'circuits'), bbPath: await writeBb('6.0.0'), paymentMode: 'testnet' }))
      .rejects.toThrow(`@noir-lang/noir_js is ${noirJs}`);
  });

  it('refuses a working-tree stamp on mainnet and accepts it on testnet', async () => {
    await bake({ worktree: true, commit: OTHER });
    const options = { circuitsDir: path.join(directory, 'circuits'), bbPath: await writeBb('6.0.0') };
    await expect(verifyCircuitsAtBoot({ ...options, paymentMode: 'mainnet' })).rejects.toThrow('a mainnet server never proves with');
    await expect(verifyCircuitsAtBoot({ ...options, paymentMode: 'testnet' })).resolves.toMatchObject({ worktree: true });
  });
});

describe('describeCheckout (the build-time half)', () => {
  let checkout: string;
  let head: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();

  beforeEach(async () => {
    checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'circuits-checkout-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await fs.writeFile(path.join(checkout, 'toolchain.env'), 'NARGO_VERSION=1.0.0\nBB_VERSION=6.0.0\n');
    for (const entry of Object.values(CIRCUIT_DIRS)) {
      const target = path.join(checkout, entry.dir, 'target');
      await fs.mkdir(path.join(target, 'vk'), { recursive: true });
      await fs.writeFile(path.join(target, `${entry.packageName}.json`), '{}');
      await fs.writeFile(path.join(target, 'vk/vk'), 'vk');
    }
    git('add', '.');
    git('commit', '-q', '-m', 'artifacts');
    head = git('rev-parse', 'HEAD');
  });
  afterEach(async () => { await fs.rm(checkout, { recursive: true, force: true }); });

  it('stamps the pinned commit with its toolchain', () => {
    expect(describeCheckout(checkout, 'pinned', head)).toEqual({
      stamp: { commit: head, worktree: false, nargoVersion: '1.0.0', bbVersion: '6.0.0' },
    });
  });

  it('pinned: refuses a checkout at another commit', () => {
    expect(() => describeCheckout(checkout, 'pinned', OTHER)).toThrow(`the checkout is at ${head}, the pin`);
  });

  it('pinned: refuses an artifact changed after the commit', async () => {
    const entry = Object.values(CIRCUIT_DIRS)[0];
    await fs.writeFile(path.join(checkout, entry.dir, 'target/vk/vk'), 'other key');
    expect(() => describeCheckout(checkout, 'pinned', head)).toThrow(`${entry.dir}/target/vk/vk`);
  });

  it('pinned: refuses a changed toolchain.env', async () => {
    await fs.writeFile(path.join(checkout, 'toolchain.env'), 'NARGO_VERSION=1.0.0\nBB_VERSION=4.2.0\n');
    expect(() => describeCheckout(checkout, 'pinned', head)).toThrow('toolchain.env');
  });

  it('pinned: refuses a missing artifact', async () => {
    const entry = Object.values(CIRCUIT_DIRS)[1];
    await fs.rm(path.join(checkout, entry.dir, 'target', `${entry.packageName}.json`));
    expect(() => describeCheckout(checkout, 'pinned', head)).toThrow(`has no ${entry.dir}/target/${entry.packageName}.json`);
  });

  it('local: stamps a changed tree as a working tree and says why', async () => {
    const entry = Object.values(CIRCUIT_DIRS)[0];
    await fs.writeFile(path.join(checkout, entry.dir, 'target/vk/vk'), 'other key');
    const result = describeCheckout(checkout, 'local', head);
    expect(result.stamp).toMatchObject({ commit: head, worktree: true });
    expect(result.reason).toContain(`${entry.dir}/target/vk/vk`);
  });

  it('local: a clean pinned checkout is stamped as pinned', () => {
    expect(describeCheckout(checkout, 'local', head).stamp.worktree).toBe(false);
  });

  it('covers toolchain.env and every circuit the server proves', () => {
    expect(stampedPaths()).toHaveLength(1 + 2 * Object.keys(CIRCUIT_DIRS).length);
  });

  it('knows only the two modes', () => {
    expect(parseCheckoutMode('pinned')).toBe('pinned');
    expect(parseCheckoutMode('local')).toBe('local');
    expect(() => parseCheckoutMode('main')).toThrow('--mode must be pinned or local (got: main)');
    expect(() => parseCheckoutMode(undefined)).toThrow('(missing)');
  });
});
