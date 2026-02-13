import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';
import { BbProver, type BbProveResult } from '../src/prover/bbProver.js';
import type { CircuitParams } from '../src/input/inputBuilder.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
}));

// Mock artifactManager
vi.mock('../src/circuit/artifactManager.js', () => ({
  createWorkDir: vi.fn(),
  cleanupWorkDir: vi.fn(),
}));

// Mock tomlBuilder
vi.mock('../src/prover/tomlBuilder.js', () => ({
  toProverToml: vi.fn(),
}));

import * as fs from 'node:fs/promises';
import * as artifactManager from '../src/circuit/artifactManager.js';
import * as tomlBuilder from '../src/prover/tomlBuilder.js';

describe('BbProver', () => {
  let prover: BbProver;
  const mockWorkDir = '/tmp/proofport-test-workdir';
  const mockConfig = {
    bbPath: '/usr/local/bin/bb',
    nargoPath: '/usr/local/bin/nargo',
    circuitsDir: '/circuits',
  };

  const mockCircuitParams: CircuitParams = {
    signalHash: new Uint8Array(32).fill(1),
    merkleRoot: '0x' + '22'.repeat(32),
    scopeBytes: new Uint8Array(32).fill(3),
    nullifierBytes: new Uint8Array(32).fill(4),
    userAddress: '0x' + '55'.repeat(20),
    userSignature: '0x' + '66'.repeat(65),
    userPubkeyX: '0x' + '77'.repeat(32),
    userPubkeyY: '0x' + '88'.repeat(32),
    rawTxBytes: Array(200).fill(9),
    txLength: 200,
    attesterPubkeyX: '0x' + 'aa'.repeat(32),
    attesterPubkeyY: '0x' + 'bb'.repeat(32),
    merkleProof: ['0x' + 'cc'.repeat(32)],
    merkleLeafIndex: 0,
    merkleDepth: 1,
  };

  beforeEach(() => {
    prover = new BbProver(mockConfig);
    vi.clearAllMocks();

    // Default mock implementations
    vi.mocked(artifactManager.createWorkDir).mockResolvedValue(mockWorkDir);
    vi.mocked(artifactManager.cleanupWorkDir).mockResolvedValue();
    vi.mocked(tomlBuilder.toProverToml).mockReturnValue('mock_toml_content');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('prove()', () => {
    it('writes Prover.toml to workDir', async () => {
      // Mock execFile to succeed for both nargo and bb
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      // Mock fs functions
      vi.mocked(fs.writeFile).mockResolvedValue();
      vi.mocked(fs.readFile).mockImplementation(async (filePath: any) => {
        if (filePath.toString().endsWith('proof')) {
          return Buffer.from('aabbccdd', 'hex');
        }
        if (filePath.toString().endsWith('public_inputs')) {
          return Buffer.from('11223344', 'hex');
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      });
      vi.mocked(fs.rename).mockResolvedValue();

      await prover.prove('coinbase_attestation', mockCircuitParams);

      expect(tomlBuilder.toProverToml).toHaveBeenCalledWith('coinbase_attestation', mockCircuitParams);
      expect(fs.writeFile).toHaveBeenCalledWith(
        path.join(mockWorkDir, 'Prover.toml'),
        'mock_toml_content'
      );
    });

    it('calls nargo execute with correct args', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      vi.mocked(fs.writeFile).mockResolvedValue();
      vi.mocked(fs.readFile).mockImplementation(async (filePath: any) => {
        if (filePath.toString().endsWith('proof')) return Buffer.from('aabbccdd', 'hex');
        if (filePath.toString().endsWith('public_inputs')) return Buffer.from('11223344', 'hex');
        throw new Error(`Unexpected file read: ${filePath}`);
      });
      vi.mocked(fs.rename).mockResolvedValue();

      await prover.prove('coinbase_attestation', mockCircuitParams);

      expect(childProcess.execFile).toHaveBeenCalledWith(
        mockConfig.nargoPath,
        ['execute', 'witness'],
        { cwd: mockWorkDir, timeout: 120000 },
        expect.any(Function)
      );
    });

    it('calls bb prove with correct args including --oracle_hash keccak', async () => {
      let callCount = 0;
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        callCount++;
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      vi.mocked(fs.writeFile).mockResolvedValue();
      vi.mocked(fs.readFile).mockImplementation(async (filePath: any) => {
        if (filePath.toString().endsWith('proof')) return Buffer.from('aabbccdd', 'hex');
        if (filePath.toString().endsWith('public_inputs')) return Buffer.from('11223344', 'hex');
        throw new Error(`Unexpected file read: ${filePath}`);
      });
      vi.mocked(fs.rename).mockResolvedValue();

      await prover.prove('coinbase_attestation', mockCircuitParams);

      const bbCalls = vi.mocked(childProcess.execFile).mock.calls.filter(
        call => call[0] === mockConfig.bbPath
      );

      // 2 bb calls: prove + off-chain verify
      expect(bbCalls.length).toBe(2);
      expect(bbCalls[0][1]).toEqual([
        'prove',
        '-b',
        'target/coinbase_attestation.json',
        '-w',
        'target/proof/witness.gz',
        '-k',
        'target/vk/vk',
        '-o',
        'target/proof',
        '--oracle_hash',
        'keccak',
      ]);
      expect(bbCalls[0][2]).toEqual({ cwd: mockWorkDir, timeout: 120000 });
    });

    it('reads proof output and returns hex-encoded result', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      vi.mocked(fs.writeFile).mockResolvedValue();
      vi.mocked(fs.readFile).mockImplementation(async (filePath: any) => {
        if (filePath.toString().endsWith('proof')) {
          return Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
        }
        if (filePath.toString().endsWith('public_inputs')) {
          return Buffer.from([0x11, 0x22, 0x33, 0x44]);
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      });
      vi.mocked(fs.rename).mockResolvedValue();

      const result = await prover.prove('coinbase_attestation', mockCircuitParams);

      expect(result).toEqual({
        proof: '0xaabbccdd',
        publicInputs: '0x11223344',
        proofWithInputs: '0xaabbccdd11223344',
      });
    });

    it('cleans up workDir on success', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      vi.mocked(fs.writeFile).mockResolvedValue();
      vi.mocked(fs.readFile).mockImplementation(async (filePath: any) => {
        if (filePath.toString().endsWith('proof')) return Buffer.from('aabbccdd', 'hex');
        if (filePath.toString().endsWith('public_inputs')) return Buffer.from('11223344', 'hex');
        throw new Error(`Unexpected file read: ${filePath}`);
      });
      vi.mocked(fs.rename).mockResolvedValue();

      await prover.prove('coinbase_attestation', mockCircuitParams);

      expect(artifactManager.cleanupWorkDir).toHaveBeenCalledWith(mockWorkDir);
    });

    it('cleans up workDir on nargo failure', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        if (cmd === mockConfig.nargoPath) {
          callback(new Error('nargo failed'), { stdout: '', stderr: 'nargo error message' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      vi.mocked(fs.writeFile).mockResolvedValue();
      vi.mocked(fs.rename).mockResolvedValue();

      await expect(prover.prove('coinbase_attestation', mockCircuitParams)).rejects.toThrow();

      expect(artifactManager.cleanupWorkDir).toHaveBeenCalledWith(mockWorkDir);
    });

    it('throws on nargo failure with stderr', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        if (cmd === mockConfig.nargoPath) {
          const error: any = new Error('Command failed');
          error.stderr = 'nargo execute failed: circuit error';
          callback(error, { stdout: '', stderr: 'nargo execute failed: circuit error' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      vi.mocked(fs.writeFile).mockResolvedValue();
      vi.mocked(fs.rename).mockResolvedValue();

      await expect(prover.prove('coinbase_attestation', mockCircuitParams)).rejects.toThrow(
        /nargo execute failed/
      );
    });

    it('throws on bb prove failure', async () => {
      let callCount = 0;
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        if (cmd === mockConfig.bbPath) {
          const error: any = new Error('bb failed');
          error.stderr = 'bb prove failed: proof generation error';
          callback(error, { stdout: '', stderr: 'bb prove failed: proof generation error' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      vi.mocked(fs.writeFile).mockResolvedValue();
      vi.mocked(fs.rename).mockResolvedValue();

      await expect(prover.prove('coinbase_attestation', mockCircuitParams)).rejects.toThrow(
        /bb prove failed/
      );
    });

    it('handles coinbase_country_attestation circuit', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      vi.mocked(fs.writeFile).mockResolvedValue();
      vi.mocked(fs.readFile).mockImplementation(async (filePath: any) => {
        if (filePath.toString().endsWith('proof')) return Buffer.from('aabbccdd', 'hex');
        if (filePath.toString().endsWith('public_inputs')) return Buffer.from('11223344', 'hex');
        throw new Error(`Unexpected file read: ${filePath}`);
      });
      vi.mocked(fs.rename).mockResolvedValue();

      await prover.prove('coinbase_country_attestation', mockCircuitParams);

      const bbCalls = vi.mocked(childProcess.execFile).mock.calls.filter(
        call => call[0] === mockConfig.bbPath
      );

      expect(bbCalls[0][1]).toContain('target/coinbase_country_attestation.json');
    });
  });

  describe('verify()', () => {
    it('returns true on successful verification', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        callback(null, { stdout: 'Verification successful', stderr: '' });
        return {} as any;
      });

      const result = await prover.verify(
        'coinbase_attestation',
        '/path/to/proof',
        '/path/to/public_inputs',
        '/path/to/vk'
      );

      expect(result).toBe(true);
      expect(childProcess.execFile).toHaveBeenCalledWith(
        mockConfig.bbPath,
        ['verify', '-p', '/path/to/proof', '-i', '/path/to/public_inputs', '-k', '/path/to/vk', '--oracle_hash', 'keccak'],
        { timeout: 30000 },
        expect.any(Function)
      );
    });

    it('returns false on verification failure', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        const error: any = new Error('Verification failed');
        error.code = 1;
        callback(error, { stdout: '', stderr: 'Invalid proof' });
        return {} as any;
      });

      const result = await prover.verify(
        'coinbase_attestation',
        '/path/to/proof',
        '/path/to/public_inputs',
        '/path/to/vk'
      );

      expect(result).toBe(false);
    });
  });
});
