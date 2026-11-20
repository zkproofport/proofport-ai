import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { CIRCUIT_DIRS } from '../src/config/circuitIds.js';
import { ensureArtifacts } from '../src/circuit/artifactManager.js';
const NARGO = '1.0.0';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
let directory: string;
let metadata: Record<string, { jsonHash: string; vkHash: string }>;
const giwaPath = () => path.join(directory, 'giwa-attestation/target/giwa_attestation.json');
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pinned-artifacts-'));
  metadata = {};
  vi.stubEnv('CIRCUITS_AUTO_UPDATE', 'false');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Pinned artifacts must not fetch'); }));
  for (const [id, entry] of Object.entries(CIRCUIT_DIRS)) {
    const target = path.join(directory, entry.dir, 'target');
    await fs.mkdir(path.join(target, 'vk'), { recursive: true });
    const json = Buffer.from(JSON.stringify({ noir_version: `${NARGO}+275d3ab1a5c916c6ea73e8d6b943f685f574500c`, bytecode: 'AQID', abi: { parameters: [] } }));
    const vk = Buffer.from('verification-key');
    await fs.writeFile(path.join(target, `${entry.packageName}.json`), json);
    await fs.writeFile(path.join(target, 'vk/vk'), vk);
    metadata[id] = { jsonHash: hash(json), vkHash: hash(vk) };
  }
  await fs.writeFile(path.join(directory, 'artifacts-meta.json'), JSON.stringify(metadata));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await fs.rm(directory, { recursive: true, force: true }); });
describe('pinned deployment artifacts', () => {
  it('validates every baked circuit without contacting remote main', async () => {
    await ensureArtifacts(directory, NARGO);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails when a baked circuit is missing instead of downloading a replacement', async () => {
    await fs.rm(giwaPath());
    await expect(ensureArtifacts(directory, NARGO)).rejects.toThrow('ENOENT');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails when a verification key is missing', async () => {
    await fs.rm(path.join(directory, 'giwa-attestation/target/vk/vk'));
    await expect(ensureArtifacts(directory, NARGO)).rejects.toThrow('ENOENT');
  });
  it('rejects tampered compiled JSON', async () => {
    await fs.appendFile(giwaPath(), ' ');
    await expect(ensureArtifacts(directory, NARGO)).rejects.toThrow('hash mismatch for giwa_attestation');
  });
  it('rejects tampered verification keys', async () => {
    await fs.appendFile(path.join(directory, 'giwa-attestation/target/vk/vk'), 'x');
    await expect(ensureArtifacts(directory, NARGO)).rejects.toThrow('hash mismatch for giwa_attestation');
  });
  it('requires the pinned hash manifest', async () => {
    await fs.rm(path.join(directory, 'artifacts-meta.json'));
    await expect(ensureArtifacts(directory, NARGO)).rejects.toThrow('hashes are missing');
  });
  it('rejects malformed compiled JSON even with matching hash', async () => {
    const bytes = Buffer.from('{}'); await fs.writeFile(giwaPath(), bytes);
    metadata.giwa_attestation.jsonHash = hash(bytes);
    await fs.writeFile(path.join(directory, 'artifacts-meta.json'), JSON.stringify(metadata));
    await expect(ensureArtifacts(directory, NARGO)).rejects.toThrow('Invalid compiled JSON');
  });
  it('validates with CIRCUITS_AUTO_UPDATE unset, which no longer means "fetch main"', async () => {
    vi.stubEnv('CIRCUITS_AUTO_UPDATE', undefined as unknown as string);
    delete process.env.CIRCUITS_AUTO_UPDATE;
    await ensureArtifacts(directory, NARGO);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses artifacts compiled by another nargo than their tree names', async () => {
    const bytes = Buffer.from(JSON.stringify({ noir_version: '1.0.0-beta.19+74d6be6', bytecode: 'AQID', abi: { parameters: [] } }));
    await fs.writeFile(giwaPath(), bytes);
    metadata.giwa_attestation.jsonHash = hash(bytes);
    await fs.writeFile(path.join(directory, 'artifacts-meta.json'), JSON.stringify(metadata));
    await expect(ensureArtifacts(directory, NARGO)).rejects.toThrow('giwa_attestation was compiled by nargo 1.0.0-beta.19, but its circuits tree names nargo 1.0.0');
  });
  it('refuses an artifact that records no compiler version', async () => {
    const bytes = Buffer.from(JSON.stringify({ bytecode: 'AQID', abi: { parameters: [] } }));
    await fs.writeFile(giwaPath(), bytes);
    metadata.giwa_attestation.jsonHash = hash(bytes);
    await fs.writeFile(path.join(directory, 'artifacts-meta.json'), JSON.stringify(metadata));
    await expect(ensureArtifacts(directory, NARGO)).rejects.toThrow('compiled by nargo (unrecorded)');
  });
  it('rejects an unknown auto-update setting', async () => {
    vi.stubEnv('CIRCUITS_AUTO_UPDATE', 'False');
    await expect(ensureArtifacts(directory, NARGO)).rejects.toThrow('CIRCUITS_AUTO_UPDATE');
  });
});
