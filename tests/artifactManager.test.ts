import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

      // 3 circuits × 2 files (json, vk) = 6 fetches
      expect(mockFetch).toHaveBeenCalledTimes(6);

      const calls = mockFetch.mock.calls.map(call => call[0]);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-attestation/target/coinbase_attestation.json`);
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
      // Pre-create all artifacts (JSON + VK for all 3 circuits)
      const circuit1Dir = path.join(circuitsDir, 'coinbase-attestation', 'target');
      const circuit2Dir = path.join(circuitsDir, 'coinbase-country-attestation', 'target');
      const circuit3Dir = path.join(circuitsDir, 'oidc-domain-attestation', 'target');

      await fs.mkdir(path.join(circuit1Dir, 'vk'), { recursive: true });
      await fs.mkdir(path.join(circuit2Dir, 'vk'), { recursive: true });
      await fs.mkdir(path.join(circuit3Dir, 'vk'), { recursive: true });

      const jsonContent = '{}';
      const vkContent = '';

      await fs.writeFile(path.join(circuit1Dir, 'coinbase_attestation.json'), jsonContent);
      await fs.writeFile(path.join(circuit1Dir, 'vk', 'vk'), vkContent);
      await fs.writeFile(path.join(circuit2Dir, 'coinbase_country_attestation.json'), jsonContent);
      await fs.writeFile(path.join(circuit2Dir, 'vk', 'vk'), vkContent);
      await fs.writeFile(path.join(circuit3Dir, 'oidc_domain_attestation.json'), jsonContent);
      await fs.writeFile(path.join(circuit3Dir, 'vk', 'vk'), vkContent);

      // Write matching hash metadata
      const crypto = await import('node:crypto');
      const jsonHash = crypto.createHash('sha256').update(jsonContent).digest('hex');
      const vkHash = crypto.createHash('sha256').update(vkContent).digest('hex');
      const meta: Record<string, { jsonHash: string; vkHash: string; downloadedAt: string }> = {};
      for (const id of ['coinbase_attestation', 'coinbase_country_attestation', 'oidc_domain_attestation']) {
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

      // fetch is called for hash checks (3 circuits × 1 JSON check each), but NOT for re-download
      // Total calls should be 3 (hash checks only), not 6+ (which would include downloads)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

});
