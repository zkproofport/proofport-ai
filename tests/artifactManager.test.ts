import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  downloadArtifacts,
  ensureArtifacts,
  getCircuitArtifactDir,
  createWorkDir,
  cleanupWorkDir,
} from '../src/circuit/artifactManager.js';

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

      // 2 circuits × 3 files (json, vk, main.nr) + 7 coinbase-libs files + 4 keccak256 files = 17 URLs
      expect(mockFetch).toHaveBeenCalledTimes(17);

      const calls = mockFetch.mock.calls.map(call => call[0]);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-attestation/target/coinbase_attestation.json`);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-attestation/target/vk/vk`);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-attestation/src/main.nr`);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-country-attestation/target/coinbase_country_attestation.json`);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-country-attestation/target/vk/vk`);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-country-attestation/src/main.nr`);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-libs/Nargo.toml`);
      expect(calls).toContain(`${repoBaseUrl}/coinbase-libs/src/lib.nr`);
    });

    it('creates correct directory structure', async () => {
      const mockFetch = vi.mocked(global.fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => '{"test": true}',
        arrayBuffer: async () => new ArrayBuffer(8),
      } as Response);

      await downloadArtifacts(circuitsDir, repoBaseUrl);

      // Check directory structure
      const circuit1Dir = path.join(circuitsDir, 'coinbase_attestation', 'target');
      const circuit1VkDir = path.join(circuit1Dir, 'vk');
      const circuit2Dir = path.join(circuitsDir, 'coinbase_country_attestation', 'target');
      const circuit2VkDir = path.join(circuit2Dir, 'vk');

      await expect(fs.stat(circuit1Dir)).resolves.toBeDefined();
      await expect(fs.stat(circuit1VkDir)).resolves.toBeDefined();
      await expect(fs.stat(circuit2Dir)).resolves.toBeDefined();
      await expect(fs.stat(circuit2VkDir)).resolves.toBeDefined();
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

    it('skips download if artifacts exist', async () => {
      // Pre-create all artifacts (target, src, coinbase-libs)
      const circuit1Dir = path.join(circuitsDir, 'coinbase_attestation', 'target');
      const circuit2Dir = path.join(circuitsDir, 'coinbase_country_attestation', 'target');
      const circuit1SrcDir = path.join(circuitsDir, 'coinbase_attestation', 'src');
      const circuit2SrcDir = path.join(circuitsDir, 'coinbase_country_attestation', 'src');
      const coinbaseLibsSrcDir = path.join(circuitsDir, 'coinbase-libs', 'src');
      const keccak256SrcDir = path.join(circuitsDir, 'keccak256', 'src');
      await fs.mkdir(path.join(circuit1Dir, 'vk'), { recursive: true });
      await fs.mkdir(path.join(circuit2Dir, 'vk'), { recursive: true });
      await fs.mkdir(circuit1SrcDir, { recursive: true });
      await fs.mkdir(circuit2SrcDir, { recursive: true });
      await fs.mkdir(coinbaseLibsSrcDir, { recursive: true });
      await fs.mkdir(keccak256SrcDir, { recursive: true });
      await fs.writeFile(path.join(circuit1Dir, 'coinbase_attestation.json'), '{}');
      await fs.writeFile(path.join(circuit1Dir, 'vk', 'vk'), '');
      await fs.writeFile(path.join(circuit1SrcDir, 'main.nr'), '');
      await fs.writeFile(path.join(circuit2Dir, 'coinbase_country_attestation.json'), '{}');
      await fs.writeFile(path.join(circuit2Dir, 'vk', 'vk'), '');
      await fs.writeFile(path.join(circuit2SrcDir, 'main.nr'), '');
      await fs.writeFile(path.join(coinbaseLibsSrcDir, 'lib.nr'), '');
      await fs.writeFile(path.join(keccak256SrcDir, 'lib.nr'), '');

      const mockFetch = vi.mocked(global.fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => '{}',
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response);

      await ensureArtifacts(circuitsDir, repoBaseUrl);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('createWorkDir', () => {
    beforeEach(async () => {
      // Create shared artifacts for testing
      const circuit1Dir = path.join(circuitsDir, 'coinbase_attestation', 'target');
      const circuit2Dir = path.join(circuitsDir, 'coinbase_country_attestation', 'target');
      await fs.mkdir(path.join(circuit1Dir, 'vk'), { recursive: true });
      await fs.mkdir(path.join(circuit2Dir, 'vk'), { recursive: true });
      await fs.writeFile(path.join(circuit1Dir, 'coinbase_attestation.json'), '{"test": true}');
      await fs.writeFile(path.join(circuit1Dir, 'vk', 'vk'), 'vk-data');
      await fs.writeFile(path.join(circuit2Dir, 'coinbase_country_attestation.json'), '{"test": true}');
      await fs.writeFile(path.join(circuit2Dir, 'vk', 'vk'), 'vk-data');
    });

    it('creates temp directory with correct structure', async () => {
      const workDir = await createWorkDir(circuitsDir, 'coinbase_attestation');

      // Check directory exists
      const stat = await fs.stat(workDir);
      expect(stat.isDirectory()).toBe(true);

      // Check it's in system temp
      expect(workDir.startsWith(os.tmpdir())).toBe(true);

      // Clean up
      await cleanupWorkDir(workDir);
    });

    it('creates Nargo.toml with correct package name', async () => {
      const workDir = await createWorkDir(circuitsDir, 'coinbase_attestation');

      const nargoToml = await fs.readFile(path.join(workDir, 'Nargo.toml'), 'utf-8');
      expect(nargoToml).toContain('name = "coinbase_attestation"');
      expect(nargoToml).toContain('type = "bin"');
      expect(nargoToml).toContain('compiler_version = ">= 1.0.0"');

      await cleanupWorkDir(workDir);
    });

    it('creates Nargo.toml with correct package name for country attestation', async () => {
      const workDir = await createWorkDir(circuitsDir, 'coinbase_country_attestation');

      const nargoToml = await fs.readFile(path.join(workDir, 'Nargo.toml'), 'utf-8');
      expect(nargoToml).toContain('name = "coinbase_country_attestation"');

      await cleanupWorkDir(workDir);
    });

    it('creates symlinks to shared artifacts', async () => {
      const workDir = await createWorkDir(circuitsDir, 'coinbase_attestation');

      // Check symlinks exist and point to correct locations
      const jsonLink = path.join(workDir, 'target', 'coinbase_attestation.json');
      const vkLink = path.join(workDir, 'target', 'vk', 'vk');

      const jsonStat = await fs.lstat(jsonLink);
      const vkStat = await fs.lstat(vkLink);

      expect(jsonStat.isSymbolicLink()).toBe(true);
      expect(vkStat.isSymbolicLink()).toBe(true);

      // Read through symlinks to verify they work
      const jsonContent = await fs.readFile(jsonLink, 'utf-8');
      const vkContent = await fs.readFile(vkLink, 'utf-8');

      expect(jsonContent).toContain('"test": true');
      expect(vkContent).toBe('vk-data');

      await cleanupWorkDir(workDir);
    });

    it('creates target/proof/ directory', async () => {
      const workDir = await createWorkDir(circuitsDir, 'coinbase_attestation');

      const proofDir = path.join(workDir, 'target', 'proof');
      const stat = await fs.stat(proofDir);
      expect(stat.isDirectory()).toBe(true);

      await cleanupWorkDir(workDir);
    });

    it('throws for unknown circuit ID', async () => {
      await expect(createWorkDir(circuitsDir, 'unknown_circuit')).rejects.toThrow('Unknown circuit ID');
    });
  });

  describe('cleanupWorkDir', () => {
    it('removes the temp directory', async () => {
      // Create a temp directory manually
      const tempDir = path.join(os.tmpdir(), `cleanup-test-${crypto.randomUUID()}`);
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(path.join(tempDir, 'test.txt'), 'test');

      // Verify it exists
      await expect(fs.stat(tempDir)).resolves.toBeDefined();

      // Clean up
      await cleanupWorkDir(tempDir);

      // Verify it's gone
      await expect(fs.stat(tempDir)).rejects.toThrow();
    });

    it('does not throw if directory does not exist', async () => {
      const nonExistent = path.join(os.tmpdir(), `nonexistent-${crypto.randomUUID()}`);
      await expect(cleanupWorkDir(nonExistent)).resolves.toBeUndefined();
    });
  });
});
