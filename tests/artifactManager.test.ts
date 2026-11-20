import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as artifactManager from '../src/circuit/artifactManager.js';

/**
 * The download path is gone (2026-11-17): the server once fetched circuits
 * `main` over the baked artifacts on boot. These hold that nothing in the
 * module downloads, whatever is or is not on disk.
 */
describe('artifactManager', () => {
  let circuitsDir: string;

  beforeEach(async () => {
    circuitsDir = path.join(os.tmpdir(), `artifact-test-${crypto.randomUUID()}`);
    await fs.mkdir(circuitsDir, { recursive: true });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('artifactManager must not fetch'); }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(circuitsDir, { recursive: true, force: true });
  });

  describe('getCircuitArtifactDir', () => {
    it('returns correct path for coinbase_attestation', () => {
      expect(artifactManager.getCircuitArtifactDir(circuitsDir, 'coinbase_attestation'))
        .toBe(path.join(circuitsDir, 'coinbase_attestation'));
    });

    it('returns correct path for coinbase_country_attestation', () => {
      expect(artifactManager.getCircuitArtifactDir(circuitsDir, 'coinbase_country_attestation'))
        .toBe(path.join(circuitsDir, 'coinbase_country_attestation'));
    });
  });

  it('exports no download function', () => {
    expect(Object.keys(artifactManager).sort()).toEqual(['ensureArtifacts', 'getCircuitArtifactDir']);
  });

  it('fails on an empty circuits directory instead of downloading', async () => {
    await expect(artifactManager.ensureArtifacts(circuitsDir, '1.0.0')).rejects.toThrow('ENOENT');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails without the nargo version the artifacts were built with', async () => {
    await expect(artifactManager.ensureArtifacts(circuitsDir, '')).rejects.toThrow('nargo version');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses CIRCUITS_AUTO_UPDATE=true, the setting that used to fetch circuits main', async () => {
    vi.stubEnv('CIRCUITS_AUTO_UPDATE', 'true');
    await expect(artifactManager.ensureArtifacts(circuitsDir, '1.0.0')).rejects.toThrow(/CIRCUITS_AUTO_UPDATE=true is no longer supported/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
