#!/usr/bin/env node
// Run from proofport-ai with Node 22.18+ (native TypeScript support).
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { concat, keccak256 } from 'ethers';
import { ARC_CIRCUIT, AUDIT_LIMITATION, candidateMatchesProof, extractArcPublicMetadata, normalizeArcPublicInputs } from './address-audit.ts';

const MAX_FILE_BYTES = 1024 * 1024;

class AuditError extends Error {}

function readBoundedFile(path: string, label: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error();
    const content = readFileSync(fd);
    if (content.byteLength > MAX_FILE_BYTES) throw new Error();
    return content.toString('utf8');
  } catch {
    throw new AuditError(`${label} must be a readable regular file no larger than 1 MiB.`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function main(): void {
  let options;
  try {
    options = parseArgs({
      options: { proof: { type: 'string' }, circuit: { type: 'string' }, candidate: { type: 'string' }, 'from-env': { type: 'boolean' }, help: { type: 'boolean' } },
      strict: true, allowPositionals: false, tokens: true,
    });
    const seen = new Set<string>();
    for (const token of options.tokens) {
      if (token.kind !== 'option') continue;
      if (seen.has(token.name)) throw new Error();
      seen.add(token.name);
    }
  } catch {
    throw new AuditError('Invalid arguments. Use --proof <file> and either --candidate <address>, CANDIDATE_ADDRESS, or --from-env.');
  }
  const values = options.values;
  if (values.help) {
    console.log('Usage: node demo/audit/compare-address.ts --proof <file> [--circuit arc_eligibility] [--candidate <address> | --from-env]\n' +
      'Without a candidate flag, CANDIDATE_ADDRESS is required. --from-env reads only E2E_ATTESTATION_WALLET_ADDRESS from .env.test in the current directory.\n' + AUDIT_LIMITATION);
    return;
  }
  if (!values.proof) throw new AuditError('--proof <file> is required.');
  if (values['from-env'] && values.candidate !== undefined) throw new AuditError('Choose one candidate source.');
  let candidate: unknown;
  if (values['from-env']) {
    try {
      candidate = parseEnv(readBoundedFile(resolve('.env.test'), 'Environment file')).E2E_ATTESTATION_WALLET_ADDRESS;
    } catch (error) {
      if (error instanceof AuditError) throw error;
      throw new AuditError('Unable to parse the environment file.');
    }
  } else if (values.candidate !== undefined) {
    candidate = values.candidate;
  } else {
    candidate = process.env.CANDIDATE_ADDRESS;
  }
  if (candidate === undefined) throw new AuditError('No candidate address supplied. Use CANDIDATE_ADDRESS, --candidate, or explicitly --from-env.');

  let document: unknown;
  try {
    document = JSON.parse(readBoundedFile(values.proof, 'Proof file'));
  } catch (error) {
    if (error instanceof AuditError) throw error;
    throw new AuditError('Proof file must contain valid JSON.');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new AuditError('Proof JSON must be an object.');
  const proof = document as Record<string, unknown>;
  if ((proof.circuitId === undefined && proof.circuit === undefined && values.circuit === undefined) ||
      (values.circuit !== undefined && values.circuit !== ARC_CIRCUIT) ||
      (proof.circuitId !== undefined && proof.circuitId !== ARC_CIRCUIT) ||
      (proof.circuit !== undefined && proof.circuit !== ARC_CIRCUIT)) {
    throw new AuditError('Identify arc_eligibility explicitly via circuitId, circuit, or --circuit; conflicting or other circuits are unsupported.');
  }
  if (typeof proof.proof !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(proof.proof)) {
    throw new AuditError('Proof JSON must contain a nonempty byte-aligned hexadecimal proof.');
  }
  let matches: boolean;
  let metadata;
  let fields: string[];
  try {
    fields = normalizeArcPublicInputs(proof.publicInputs);
    metadata = extractArcPublicMetadata(fields);
    matches = candidateMatchesProof(fields, candidate);
  } catch (error) {
    // These pure helpers emit fixed messages and indices, never input values.
    if (error instanceof Error) throw new AuditError(error.message);
    throw new AuditError('Invalid candidate or public inputs.');
  }
  console.log(JSON.stringify({
    circuitId: ARC_CIRCUIT,
    proofFingerprint: keccak256(concat([proof.proof, ...fields])),
    publicInputsFingerprint: metadata.publicInputsFingerprint,
    matches,
    proofVerified: false,
    limitations: AUDIT_LIMITATION,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof AuditError ? error.message : 'Address audit failed.');
  process.exitCode = 1;
}
