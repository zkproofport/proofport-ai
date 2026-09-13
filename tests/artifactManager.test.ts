import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROVABLE_CIRCUIT_IDS } from '../src/config/circuitIds.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { downloadArtifacts, ensureArtifacts, getCircuitArtifactDir } from '../src/circuit/artifactManager.js';

describe('artifactManager', () => {
  let testDir: string;
  let circuitsDir: string;

  beforeEach(async () => {
    // Create unique test directory
    testDir = path.join(os.tmpdir(), `artifact-test-${crypto.randomUUID()}`);
    circuitsDir = path.join(testDir, 'circuits');
    await fs.mkdir(circuitsDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('getCircuitArtifactDir', () => {
    it('returns correct path for coinbase_attestation', () => {
      const result = getCircuitArtifactDir(circuitsDir, 'coinbase_attestation');
      expect(result).toBe(path.join(circuitsDir, 'coinbase_attestation'));
    });

    it('returns correct path for coinbase_country_attestation', () => {
      const result = getCircuitArtifactDir(circuitsDir, 'coinbase_country_attestation');
      expect(result).toBe(path.join(circuitsDir, 'coinbase_country_attestation'));
    });
  });

  describe('downloadArtifacts', () => {
    const repoBaseUrl = 'https://raw.githubusercontent.com/zkproofport/circuits/main';

    beforeEach(() => {
      // Mock global fetch
      global.fetch = vi.fn();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('fetches correct URLs for all circuits', async () => {
      const mockFetch = vi.mocked(global.fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => '{}',
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response);

      await downloadArtifacts(circuitsDir, repoBaseUrl);

      // Two files per circuit: the compiled json and the verification key.
      expect(mockFetch).toHaveBeenCalledTimes(PROVABLE_CIRCUIT_IDS.length * 2);

      const calls = mockFetch.mock.calls.map(call => call[0]);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-attestation/target/coinbase_attestation.json`);
      expect(calls).toContain(`${repoBaseUrl}/arc-eligibility/target/arc_eligibility.json`);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-attestation/target/vk/vk`);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-country-attestation/target/coinbase_country_attestation.json`);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-country-attestation/target/vk/vk`);
      expect(calls).toContain(`${repoBaseUrl}/oidc-domain-attestation/target/oidc_domain_attestation.json`);
      expect(calls).toContain(`${repoBaseUrl}/oidc-domain-attestation/target/vk/vk`);
    });

    it('creates correct directory structure', async () => {
      const mockFetch = vi.mocked(global.fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => '{"test": true}',
        arrayBuffer: async () => new ArrayBuffer(8),
      } as Response);

      await downloadArtifacts(circuitsDir, repoBaseUrl);

      // Check directory structure for all 3 circuits
      const circuit1Dir = path.join(circuitsDir, 'coinbase-attestation', 'target');
      const circuit1VkDir = path.join(circuit1Dir, 'vk');
      const circuit2Dir = path.join(circuitsDir, 'coinbase-country-attestation', 'target');
      const circuit2VkDir = path.join(circuit2Dir, 'vk');
      const circuit3Dir = path.join(circuitsDir, 'oidc-domain-attestation', 'target');
      const circuit4Dir = path.join(circuitsDir, 'arc-eligibility', 'target');
      const circuit3VkDir = path.join(circuit3Dir, 'vk');

      await expect(fs.stat(circuit1Dir)).resolves.toBeDefined();
      await expect(fs.stat(circuit1VkDir)).resolves.toBeDefined();
      await expect(fs.stat(circuit2Dir)).resolves.toBeDefined();
      await expect(fs.stat(circuit2VkDir)).resolves.toBeDefined();
      await expect(fs.stat(circuit3Dir)).resolves.toBeDefined();
      await expect(fs.stat(circuit3VkDir)).resolves.toBeDefined();
    });

    it('throws if fetch fails', async () => {
      const mockFetch = vi.mocked(global.fetch);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

      await expect(downloadArtifacts(circuitsDir, repoBaseUrl)).rejects.toThrow();
    });
  });

  describe('ensureArtifacts', () => {
    const repoBaseUrl = 'https://raw.githubusercontent.com/zkproofport/circuits/main';

    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('downloads if artifacts do not exist', async () => {
      const mockFetch = vi.mocked(global.fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => '{}',
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response);

      await ensureArtifacts(circuitsDir, repoBaseUrl);

      expect(mockFetch).toHaveBeenCalled();
    });

    it('skips re-download if artifacts exist and hashes match', async () => {
      // Pre-create all artifacts (JSON + VK for all 4 circuits)
      const circuit1Dir = path.join(circuitsDir, 'coinbase-attestation', 'target');
      const circuit2Dir = path.join(circuitsDir, 'coinbase-country-attestation', 'target');
      const circuit3Dir = path.join(circuitsDir, 'oidc-domain-attestation', 'target');
      const circuit4Dir = path.join(circuitsDir, 'arc-eligibility', 'target');

      await fs.mkdir(path.join(circuit1Dir, 'vk'), { recursive: true });
      await fs.mkdir(path.join(circuit2Dir, 'vk'), { recursive: true });
      await fs.mkdir(path.join(circuit3Dir, 'vk'), { recursive: true });
      await fs.mkdir(path.join(circuit4Dir, 'vk'), { recursive: true });

      const jsonContent = '{}';
      const vkContent = '';

      await fs.writeFile(path.join(circuit1Dir, 'coinbase_attestation.json'), jsonContent);
      await fs.writeFile(path.join(circuit1Dir, 'vk', 'vk'), vkContent);
      await fs.writeFile(path.join(circuit2Dir, 'coinbase_country_attestation.json'), jsonContent);
      await fs.writeFile(path.join(circuit2Dir, 'vk', 'vk'), vkContent);
      await fs.writeFile(path.join(circuit3Dir, 'oidc_domain_attestation.json'), jsonContent);
      await fs.writeFile(path.join(circuit3Dir, 'vk', 'vk'), vkContent);
      await fs.writeFile(path.join(circuit4Dir, 'arc_eligibility.json'), jsonContent);
      await fs.writeFile(path.join(circuit4Dir, 'vk', 'vk'), vkContent);

      // Write matching hash metadata
      const crypto = await import('node:crypto');
      const jsonHash = crypto.createHash('sha256').update(jsonContent).digest('hex');
      const vkHash = crypto.createHash('sha256').update(vkContent).digest('hex');
      // Derived from the id list, not typed out. A hardcoded list here missed
      // arc_eligibility when it was added: that circuit had no stored hash, so
      // ensureArtifacts re-downloaded EVERY circuit and the call count went
      // from 3 to 11 -- a failure that names a number and not the cause.
      const meta: Record<string, { jsonHash: string; vkHash: string; downloadedAt: string }> = {};
      for (const id of PROVABLE_CIRCUIT_IDS) {
        meta[id] = { jsonHash, vkHash, downloadedAt: new Date().toISOString() };
      }
      await fs.writeFile(path.join(circuitsDir, 'artifacts-meta.json'), JSON.stringify(meta));

      const mockFetch = vi.mocked(global.fetch);
      // Remote hash check returns same content → hashes match → no re-download
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => jsonContent,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response);

      await ensureArtifacts(circuitsDir, repoBaseUrl);

      // One JSON hash check per circuit, and no re-download. Counted from
      // the id list so adding a circuit does not silently change what this
      // asserts.
      expect(mockFetch).toHaveBeenCalledTimes(PROVABLE_CIRCUIT_IDS.length);
    });
  });


  describe('artifacts put there by hand', () => {
    /**
     * `scripts/ai-dev.sh` copies compiled circuits from the sibling circuits
     * repo, which is the documented way to run a circuit that has not been
     * pushed to the remote branch yet.
     *
     * Both cases here failed before 2026-09-09 and together they stopped the
     * local container from starting at all: a hand-copied circuit had no entry
     * in artifacts-meta.json, so it was queued for download; and one queued
     * circuit re-downloaded EVERY circuit, so the 404 for the unpushed one
     * threw away three local copies that were already correct.
     */
    async function placeCircuit(circuitDir: string, packageName: string) {
      const target = path.join(circuitsDir, circuitDir, 'target');
      await fs.mkdir(path.join(target, 'vk'), { recursive: true });
      await fs.writeFile(path.join(target, `${packageName}.json`), '{"bytecode":"local"}');
      await fs.writeFile(path.join(target, 'vk', 'vk'), Buffer.from([1, 2, 3]));
    }

    it('adopts a local circuit that has no recorded hash, and starts', async () => {
      for (const id of PROVABLE_CIRCUIT_IDS) {
        await placeCircuit(id.replace(/_/g, '-'), id);
      }

      // A base URL that 404s on everything, standing in for a circuit that
      // exists locally and has not been pushed. This is what threw before:
      // no recorded hash meant "download", and the download 404ed and took
      // the whole boot with it.
      await expect(
        ensureArtifacts(circuitsDir, 'https://example.invalid/nothing-here'),
      ).resolves.toBeUndefined();

      const meta = JSON.parse(await fs.readFile(path.join(circuitsDir, 'artifacts-meta.json'), 'utf-8'));
      for (const id of PROVABLE_CIRCUIT_IDS) {
        expect(meta[id]?.jsonHash, `${id} should have had its local hash recorded`).toBeTruthy();
      }

      // The local bytes are still the local bytes. `ensureArtifacts` still
      // asks the remote whether it has something different -- that drift check
      // is why the hashes are recorded at all, and the remote is authoritative
      // once a circuit IS pushed. What must not happen is a failed or absent
      // remote deleting what is on disk.
      for (const id of PROVABLE_CIRCUIT_IDS) {
        const local = path.join(circuitsDir, id.replace(/_/g, '-'), 'target', `${id}.json`);
        await expect(fs.readFile(local, 'utf-8')).resolves.toContain('local');
      }
    });

    it('keeps a local circuit when the remote cannot be reached', async () => {
      for (const id of PROVABLE_CIRCUIT_IDS) {
        await placeCircuit(id.replace(/_/g, '-'), id);
      }
      // Record hashes first, so the second pass reaches the remote comparison.
      await ensureArtifacts(circuitsDir, 'https://example.invalid/nothing-here');

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
      await expect(ensureArtifacts(circuitsDir, 'https://example.invalid/nothing-here')).resolves.toBeUndefined();

      // Still there. A failed remote check must not delete working artifacts.
      const first = PROVABLE_CIRCUIT_IDS[0];
      const stillThere = path.join(circuitsDir, first.replace(/_/g, '-'), 'target', `${first}.json`);
      await expect(fs.readFile(stillThere, 'utf-8')).resolves.toContain('local');
      fetchSpy.mockRestore();
    });
  });
});
