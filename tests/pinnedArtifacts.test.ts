import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { CIRCUIT_DIRS } from '../src/config/circuitIds.js';
import { ensureArtifacts } from '../src/circuit/artifactManager.js';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
let directory: string;
let metadata: Record<string, { jsonHash: string; vkHash: string }>;
const arcPath = () => path.join(directory, 'arc-eligibility/target/arc_eligibility.json');
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pinned-artifacts-'));
  metadata = {};
  vi.stubEnv('CIRCUITS_AUTO_UPDATE', 'false');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Pinned artifacts must not fetch'); }));
  for (const [id, entry] of Object.entries(CIRCUIT_DIRS)) {
    const target = path.join(directory, entry.dir, 'target');
    await fs.mkdir(path.join(target, 'vk'), { recursive: true });
    const json = Buffer.from(JSON.stringify({ bytecode: 'AQID', abi: { parameters: [] } }));
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
    await ensureArtifacts(directory);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails when a baked circuit is missing instead of downloading a replacement', async () => {
    await fs.rm(arcPath());
    await expect(ensureArtifacts(directory)).rejects.toThrow('ENOENT');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails when a verification key is missing', async () => {
    await fs.rm(path.join(directory, 'arc-eligibility/target/vk/vk'));
    await expect(ensureArtifacts(directory)).rejects.toThrow('ENOENT');
  });
  it('rejects tampered compiled JSON', async () => {
    await fs.appendFile(arcPath(), ' ');
    await expect(ensureArtifacts(directory)).rejects.toThrow('hash mismatch for arc_eligibility');
  });
  it('rejects tampered verification keys', async () => {
    await fs.appendFile(path.join(directory, 'arc-eligibility/target/vk/vk'), 'x');
    await expect(ensureArtifacts(directory)).rejects.toThrow('hash mismatch for arc_eligibility');
  });
  it('requires the pinned hash manifest', async () => {
    await fs.rm(path.join(directory, 'artifacts-meta.json'));
    await expect(ensureArtifacts(directory)).rejects.toThrow('hashes are missing');
  });
  it('rejects malformed compiled JSON even with matching hash', async () => {
    const bytes = Buffer.from('{}'); await fs.writeFile(arcPath(), bytes);
    metadata.arc_eligibility.jsonHash = hash(bytes);
    await fs.writeFile(path.join(directory, 'artifacts-meta.json'), JSON.stringify(metadata));
    await expect(ensureArtifacts(directory)).rejects.toThrow('Invalid compiled JSON');
  });
  it('rejects an unknown auto-update setting', async () => {
    vi.stubEnv('CIRCUITS_AUTO_UPDATE', 'False');
    await expect(ensureArtifacts(directory)).rejects.toThrow('CIRCUITS_AUTO_UPDATE');
  });
});
