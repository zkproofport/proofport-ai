import { afterEach, describe, expect, it } from 'vitest';
import { concat, getBytes, keccak256, solidityPackedKeccak256, toBeHex, zeroPadValue } from 'ethers';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  candidateMatchesProof,
  extractArcPublicMetadata,
  normalizeArcPublicInputs,
} from '../demo/audit/address-audit.ts';

const candidate = '0x1234567890123456789012345678901234567890';
const wrongCandidate = '0x1234567890123456789012345678901234567891';
const signal = '0x' + 'a1'.repeat(32);
const scope = '0x' + 'b2'.repeat(32);
const nullifier = solidityPackedKeccak256(['bytes32', 'bytes32'], [
  solidityPackedKeccak256(['address', 'bytes32'], [candidate, signal]), scope,
]);
const bytes = concat([signal, '0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32), scope, nullifier]);
const fields = Array.from(getBytes(bytes), (byte) => zeroPadValue(toBeHex(byte), 32));
const packed = concat(fields);
const fixture = { circuitId: 'arc_eligibility', proof: '0x1234', publicInputs: packed };

describe('Arc candidate address audit', () => {
  it('matches the supplied address and rejects a one-byte-different address', () => {
    expect(candidateMatchesProof(fields, candidate)).toBe(true);
    expect(candidateMatchesProof(fields, wrongCandidate)).toBe(false);
  });

  it('agrees for packed hex and bytes32 array without mutating inputs', () => {
    const frozen = Object.freeze([...fields]);
    expect(candidateMatchesProof(packed, candidate)).toBe(true);
    expect(extractArcPublicMetadata(packed)).toEqual(extractArcPublicMetadata(frozen));
    expect(normalizeArcPublicInputs(packed)).toEqual(fields);
  });

  it('extracts all six hashes with the circuit ABI offsets', () => {
    expect(extractArcPublicMetadata(packed)).toEqual({
      circuitId: 'arc_eligibility', publicInputCount: 192,
      publicInputsFingerprint: keccak256(packed), signalHash: signal,
      domainSeparator: '0x' + '11'.repeat(32), actionHash: '0x' + '22'.repeat(32),
      signerRoot: '0x' + '33'.repeat(32), scope, nullifier,
    });
    expect(JSON.stringify(extractArcPublicMetadata(packed))).not.toContain(candidate);
  });

  it.each([0, 31, 128, 159, 160, 191])('detects a mutation at byte %i', (index) => {
    const mutated = [...fields];
    mutated[index] = zeroPadValue(toBeHex(Number(BigInt(mutated[index])) ^ 1), 32);
    expect(candidateMatchesProof(mutated, candidate)).toBe(false);
  });

  it('does not pretend that matching authenticates the other public inputs', () => {
    const mutated = [...fields];
    mutated[32] = zeroPadValue('0xff', 32);
    expect(candidateMatchesProof(mutated, candidate)).toBe(true);
    expect(extractArcPublicMetadata(mutated).publicInputsFingerprint).not.toBe(keccak256(packed));
  });

  it.each([0, 1, 255])('accepts byte boundary %i in public fields', (value) => {
    expect(normalizeArcPublicInputs(Array(192).fill(zeroPadValue(toBeHex(value), 32)))).toHaveLength(192);
  });

  it('accepts uppercase hex bytes in public fields', () => {
    const upperFields = fields.map((field) => '0x' + field.slice(2).toUpperCase());
    expect(candidateMatchesProof(upperFields, candidate)).toBe(true);
  });

  it.each(['0x' + '00'.repeat(20), '0x' + 'ff'.repeat(20), '0x' + 'FF'.repeat(20)])('accepts address byte boundaries #%#', (address) => {
    expect(candidateMatchesProof(fields, address)).toBe(false);
  });

  it.each([undefined, null, '', ' ', '0x', packed.slice(2), packed + '00', packed.slice(0, -2),
    '0x' + '00'.repeat(192), [], fields.slice(0, 191), [...fields, fields[0]], new Array(192),
    0, {}, '0x' + 'f'.repeat(30000), '<script>', '한국어🙂', '\n\t', '%_\\'].map((input) => ({ input })))('rejects malformed public inputs #%#', ({ input }) => {
    expect(() => candidateMatchesProof(input, candidate)).toThrow(/public\s?input/i);
  });

  it.each(['0x100', zeroPadValue('0x0100', 32), '0x00', '-1', 255, null, '', '0x' + 'gg'.repeat(32)])(
    'rejects a malformed field #%#', (field) => {
      const malformed: unknown[] = [...fields];
      malformed[100] = field;
      expect(() => candidateMatchesProof(malformed, candidate)).toThrow(/index 100/);
    },
  );

  it.each([null, undefined, '', ' ', '0x', candidate.slice(2), candidate + '00',
    '0x' + 'ab'.repeat(32), '<script>', '한국어🙂', '\n\t', '%_\\', 0])('rejects and redacts malformed candidate #%#', (address) => {
    expect(() => candidateMatchesProof(fields, address)).toThrow('Candidate address must be exactly 20 bytes of 0x-prefixed hexadecimal.');
  });
});

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function runCli(args: string[], env: NodeJS.ProcessEnv = {}, proof: unknown = fixture, envFile?: string, rawProof?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'arc-address-audit-'));
  directories.push(directory);
  const path = join(directory, 'proof.json');
  writeFileSync(path, rawProof === undefined ? JSON.stringify(proof) : rawProof);
  if (envFile !== undefined) writeFileSync(join(directory, '.env.test'), envFile);
  const childEnv = { ...process.env, ...env };
  delete childEnv.CANDIDATE_ADDRESS;
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('demo/audit/compare-address.ts'), '--proof', path, ...args], {
    cwd: directory, env: childEnv, encoding: 'utf8', timeout: 10000,
  });
}

describe('offline audit CLI', () => {
  it('accepts an environment candidate and emits only safe results', () => {
    const result = runCli([], { CANDIDATE_ADDRESS: candidate });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.matches).toBe(true);
    expect(output.proofFingerprint).toBe(keccak256(concat([fixture.proof, packed])));
    expect(output.limitations).toContain('does not invert a hash');
    expect(output.proofVerified).toBe(false);
    expect(result.stdout + result.stderr).not.toContain(candidate);
  });

  it('reports a non-match without failing the command', () => {
    const result = runCli(['--candidate', wrongCandidate]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).matches).toBe(false);
  });

  it('reads the dotenv address only with --from-env and never prints private keys', () => {
    const secret = 'PRIVATE_KEY_SHOULD_NEVER_APPEAR';
    const envText = `E2E_ATTESTATION_WALLET_ADDRESS="${candidate}" # fixture\nPRIVATE_KEY=${secret}\n`;
    const rejected = runCli([], {}, fixture, envText);
    expect(rejected.status).toBe(1);
    const accepted = runCli(['--from-env'], {}, fixture, envText);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout).matches).toBe(true);
    expect(accepted.stdout + accepted.stderr + rejected.stderr).not.toContain(secret);
    expect(accepted.stdout + accepted.stderr).not.toContain(candidate);
  });

  it('does not evaluate shell syntax in the dotenv file', () => {
    const result = runCli(['--from-env'], {}, fixture,
      'E2E_ATTESTATION_WALLET_ADDRESS=$(printf secret_value)\n');
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('secret_value');
  });

  it('rejects malformed JSON without echoing its contents', () => {
    const result = runCli([], { CANDIDATE_ADDRESS: candidate }, fixture, undefined, '{"SECRET_DO_NOT_PRINT": invalid}');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('valid JSON');
    expect(result.stderr).not.toContain('SECRET_DO_NOT_PRINT');
  });

  it('caps proof file size before parsing', () => {
    const result = runCli([], { CANDIDATE_ADDRESS: candidate }, fixture, undefined, 'x'.repeat(1024 * 1024 + 1));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no larger than 1 MiB');
  });

  it('reports a missing environment file without a stack or path', () => {
    const result = runCli(['--from-env']);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('Environment file must be a readable regular file no larger than 1 MiB.');
  });

  it.each([
    ['--candidate'], ['--unknown', candidate], ['--candidate', candidate, '--candidate', candidate],
    ['--from-env', '--candidate', candidate], ['--proof', 'another.json'],
  ].map((args) => ({ args })))('rejects conflicting or malformed CLI arguments #%#', ({ args }) => {
    const result = runCli(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(candidate);
  });

  it('requires explicit trusted circuit context for an unlabelled export', () => {
    const result = runCli(['--circuit', 'arc_eligibility'], { CANDIDATE_ADDRESS: candidate },
      { proof: fixture.proof, publicInputs: packed });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).matches).toBe(true);
  });

  it('rejects explicit circuit context that disagrees with the export', () => {
    const result = runCli(['--circuit', 'coinbase_attestation'], { CANDIDATE_ADDRESS: candidate });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it.each([
    { ...fixture, circuitId: 'coinbase_attestation' }, { ...fixture, circuit: 'oidc_domain_attestation' },
    { ...fixture, proof: '' }, { ...fixture, proof: '0x1' }, { ...fixture, publicInputs: [] },
    { proof: fixture.proof, publicInputs: packed }, null,
  ])('rejects invalid or unidentified proof documents #%#', (proof) => {
    const result = runCli([], { CANDIDATE_ADDRESS: candidate }, proof);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});
