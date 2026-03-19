import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { BbProver, type BbProveResult } from '../src/prover/bbProver.js';
import type { CircuitParams } from '../src/input/inputBuilder.js';

// Mock child_process — must work with promisify(execFile)
vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd: any, args: any, opts: any, cb: any) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    cb(null, { stdout: '', stderr: '' });
    return {} as any;
  }),
}));

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));

// Mock @noir-lang/noir_js
vi.mock('@noir-lang/noir_js', () => ({
  Noir: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ witness: new Uint8Array([1, 2, 3]) }),
  })),
}));

// Mock inputFormatter
vi.mock('../src/prover/inputFormatter.js', () => ({
  formatCoinbaseInputs: vi.fn().mockReturnValue({ mock: 'inputs' }),
  formatOidcInputs: vi.fn().mockReturnValue({ mock: 'oidc_inputs' }),
}));

// Mock oidcProver
vi.mock('../src/prover/oidcProver.js', () => ({
  prepareOidcCircuitInputs: vi.fn().mockReturnValue({ mock: 'oidc_circuit_inputs' }),
}));

import * as fs from 'node:fs/promises';
import { Noir } from '@noir-lang/noir_js';
import * as inputFormatter from '../src/prover/inputFormatter.js';

describe('BbProver', () => {
  let prover: BbProver;
  const mockConfig = {
    bbPath: '/usr/local/bin/bb',
    circuitsDir: '/circuits',
  };

  // Minimal CircuitParams for tests
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

  // Default success mocks for fs
  function setupSuccessFsMocks() {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as any);
    vi.mocked(fs.writeFile).mockResolvedValue();
    vi.mocked(fs.rm).mockResolvedValue();
    vi.mocked(fs.readFile).mockImplementation(async (filePath: any) => {
      const p = filePath.toString();
      if (p.endsWith('/proof')) return Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
      if (p.endsWith('/public_inputs')) return Buffer.from([0x11, 0x22, 0x33, 0x44]);
      // circuit JSON
      return JSON.stringify({ bytecode: 'mock' });
    });
  }

  beforeEach(() => {
    prover = new BbProver(mockConfig);
    vi.clearAllMocks();

    // Re-apply default mock implementations after clearAllMocks
    vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, cb: any) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      cb(null, { stdout: '', stderr: '' });
      return {} as any;
    });

    vi.mocked(Noir).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ witness: new Uint8Array([1, 2, 3]) }),
    }));

    vi.mocked(inputFormatter.formatCoinbaseInputs).mockReturnValue({ mock: 'inputs' } as any);
    vi.mocked(inputFormatter.formatOidcInputs).mockReturnValue({ mock: 'oidc_inputs' } as any);

    setupSuccessFsMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('prove()', () => {
    it('throws on unknown circuit ID', async () => {
      await expect(prover.prove('unknown_circuit', {})).rejects.toThrow('Unknown circuit ID: unknown_circuit');
    });

    it('loads circuit JSON from correct path for coinbase_attestation', async () => {
      await prover.prove('coinbase_attestation', mockCircuitParams);

      const expectedPath = path.join(
        mockConfig.circuitsDir,
        'coinbase-attestation',
        'target',
        'coinbase_attestation.json'
      );
      expect(fs.readFile).toHaveBeenCalledWith(expectedPath, 'utf-8');
    });

    it('formats coinbase inputs via inputFormatter', async () => {
      await prover.prove('coinbase_attestation', mockCircuitParams);

      expect(inputFormatter.formatCoinbaseInputs).toHaveBeenCalledWith(
        'coinbase_attestation',
        mockCircuitParams
      );
    });

    it('formats OIDC inputs via oidcProver + inputFormatter for oidc_domain_attestation', async () => {
      const oidcPayload = { jwt: 'test', jwks: { keys: [] }, scope: 'test', provider: 'google' };
      await prover.prove('oidc_domain_attestation', oidcPayload);

      const { prepareOidcCircuitInputs } = await import('../src/prover/oidcProver.js');
      expect(prepareOidcCircuitInputs).toHaveBeenCalledWith(oidcPayload);
      expect(inputFormatter.formatOidcInputs).toHaveBeenCalledWith({ mock: 'oidc_circuit_inputs' });
      expect(inputFormatter.formatCoinbaseInputs).not.toHaveBeenCalled();
    });

    it('calls noir_js Noir.execute() with formatted inputs', async () => {
      const mockExecute = vi.fn().mockResolvedValue({ witness: new Uint8Array([1, 2, 3]) });
      vi.mocked(Noir).mockImplementation(() => ({ execute: mockExecute }));

      await prover.prove('coinbase_attestation', mockCircuitParams);

      expect(mockExecute).toHaveBeenCalledWith({ mock: 'inputs' });
    });

    it('writes compressed witness to temp dir', async () => {
      const mockExecute = vi.fn().mockResolvedValue({ witness: new Uint8Array([0xde, 0xad]) });
      vi.mocked(Noir).mockImplementation(() => ({ execute: mockExecute }));

      await prover.prove('coinbase_attestation', mockCircuitParams);

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/witness\.gz$/),
        new Uint8Array([0xde, 0xad])
      );
    });

    it('calls bb prove with correct args including --oracle_hash keccak and -k vk', async () => {
      await prover.prove('coinbase_attestation', mockCircuitParams);

      const bbCalls = vi.mocked(childProcess.execFile).mock.calls.filter(
        call => call[0] === mockConfig.bbPath && (call[1] as string[])[0] === 'prove'
      );

      expect(bbCalls.length).toBe(1);
      const args = bbCalls[0][1] as string[];

      expect(args[0]).toBe('prove');
      expect(args).toContain('-b');
      expect(args).toContain('-w');
      expect(args).toContain('-k');
      expect(args).toContain('-o');
      expect(args).toContain('--oracle_hash');
      expect(args).toContain('keccak');

      // -b points to circuit JSON
      const bIdx = args.indexOf('-b');
      expect(args[bIdx + 1]).toMatch(/coinbase-attestation\/target\/coinbase_attestation\.json$/);

      // -k points to vk
      const kIdx = args.indexOf('-k');
      expect(args[kIdx + 1]).toMatch(/coinbase-attestation\/target\/vk\/vk$/);

      // bb prove uses timeout of 120000
      const opts = bbCalls[0][2] as any;
      expect(opts?.timeout ?? (bbCalls[0][3] as any)?.timeout).toBeDefined();
    });

    it('calls bb verify after bb prove (off-chain verification)', async () => {
      await prover.prove('coinbase_attestation', mockCircuitParams);

      const bbCalls = vi.mocked(childProcess.execFile).mock.calls.filter(
        call => call[0] === mockConfig.bbPath
      );

      // 2 bb calls: prove + verify
      expect(bbCalls.length).toBe(2);
      expect((bbCalls[1][1] as string[])[0]).toBe('verify');
    });

    it('calls bb verify with --oracle_hash keccak', async () => {
      await prover.prove('coinbase_attestation', mockCircuitParams);

      const verifyCall = vi.mocked(childProcess.execFile).mock.calls.find(
        call => call[0] === mockConfig.bbPath && (call[1] as string[])[0] === 'verify'
      );

      expect(verifyCall).toBeDefined();
      const args = verifyCall![1] as string[];
      expect(args).toContain('--oracle_hash');
      expect(args).toContain('keccak');
    });

    it('reads proof output and returns hex-encoded result', async () => {
      vi.mocked(fs.readFile).mockImplementation(async (filePath: any) => {
        const p = filePath.toString();
        if (p.endsWith('/proof')) return Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
        if (p.endsWith('/public_inputs')) return Buffer.from([0x11, 0x22, 0x33, 0x44]);
        return JSON.stringify({ bytecode: 'mock' });
      });

      const result = await prover.prove('coinbase_attestation', mockCircuitParams);

      expect(result).toEqual({
        proof: '0xaabbccdd',
        publicInputs: '0x11223344',
        proofWithInputs: '0xaabbccdd11223344',
      });
    });

    it('cleans up temp dir on success', async () => {
      await prover.prove('coinbase_attestation', mockCircuitParams);

      expect(fs.rm).toHaveBeenCalledWith(
        expect.stringMatching(/proofport-/),
        { recursive: true, force: true }
      );
    });

    it('cleans up temp dir on noir_js execute failure', async () => {
      vi.mocked(Noir).mockImplementation(() => ({
        execute: vi.fn().mockRejectedValue(new Error('circuit constraint failed')),
      }));

      await expect(prover.prove('coinbase_attestation', mockCircuitParams)).rejects.toThrow(
        /noir_js execute failed/
      );

      expect(fs.rm).toHaveBeenCalledWith(
        expect.stringMatching(/proofport-/),
        { recursive: true, force: true }
      );
    });

    it('throws with noir_js error message on execute failure', async () => {
      vi.mocked(Noir).mockImplementation(() => ({
        execute: vi.fn().mockRejectedValue(new Error('circuit constraint violated')),
      }));

      await expect(prover.prove('coinbase_attestation', mockCircuitParams)).rejects.toThrow(
        'noir_js execute failed: circuit constraint violated'
      );
    });

    it('cleans up temp dir on bb prove failure', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, cb: any) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        if (cmd === mockConfig.bbPath && (args as string[])[0] === 'prove') {
          const err: any = new Error('bb failed');
          err.stderr = 'proof generation error';
          cb(err, { stdout: '', stderr: 'proof generation error' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      await expect(prover.prove('coinbase_attestation', mockCircuitParams)).rejects.toThrow();

      expect(fs.rm).toHaveBeenCalledWith(
        expect.stringMatching(/proofport-/),
        { recursive: true, force: true }
      );
    });

    it('throws on bb prove failure with stderr', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, cb: any) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        if (cmd === mockConfig.bbPath && (args as string[])[0] === 'prove') {
          const err: any = new Error('Command failed');
          err.stderr = 'SumcheckFailed()';
          cb(err, { stdout: '', stderr: 'SumcheckFailed()' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      await expect(prover.prove('coinbase_attestation', mockCircuitParams)).rejects.toThrow(
        /bb prove failed/
      );
    });

    it('throws when off-chain verification fails', async () => {
      let bbCallCount = 0;
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, cb: any) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        if (cmd === mockConfig.bbPath) {
          bbCallCount++;
          if (bbCallCount === 2) {
            // second bb call = verify → fail
            const err: any = new Error('verify failed');
            err.stderr = 'Invalid proof';
            cb(err, { stdout: '', stderr: 'Invalid proof' });
            return {} as any;
          }
        }
        cb(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      await expect(prover.prove('coinbase_attestation', mockCircuitParams)).rejects.toThrow(
        'Off-chain proof verification failed'
      );
    });

    it('handles coinbase_country_attestation circuit', async () => {
      await prover.prove('coinbase_country_attestation', mockCircuitParams);

      expect(inputFormatter.formatCoinbaseInputs).toHaveBeenCalledWith(
        'coinbase_country_attestation',
        mockCircuitParams
      );

      const bbProveCall = vi.mocked(childProcess.execFile).mock.calls.find(
        call => call[0] === mockConfig.bbPath && (call[1] as string[])[0] === 'prove'
      );

      const args = bbProveCall![1] as string[];
      const bIdx = args.indexOf('-b');
      expect(args[bIdx + 1]).toMatch(/coinbase-country-attestation\/target\/coinbase_country_attestation\.json$/);
    });

    it('creates temp dir with proofDir subdirectory', async () => {
      await prover.prove('coinbase_attestation', mockCircuitParams);

      expect(fs.mkdir).toHaveBeenCalledWith(
        expect.stringMatching(/proofport-.+\/proof$/),
        { recursive: true }
      );
    });
  });

  describe('verify()', () => {
    it('returns true on successful verification', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, cb: any) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        cb(null, { stdout: 'Verification successful', stderr: '' });
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
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, cb: any) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        const err: any = new Error('Verification failed');
        err.code = 1;
        cb(err, { stdout: '', stderr: 'Invalid proof' });
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

    it('returns false (does not throw) on bb verify error', async () => {
      vi.mocked(childProcess.execFile).mockImplementation((cmd: any, args: any, opts: any, cb: any) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        cb(new Error('unexpected crash'), null);
        return {} as any;
      });

      await expect(prover.verify('coinbase_attestation', '/p', '/i', '/k')).resolves.toBe(false);
    });
  });
});
