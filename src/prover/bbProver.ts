import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { Noir } from '@noir-lang/noir_js';
import type { CircuitParams } from '../input/inputBuilder.js';
import type { OidcCircuitInputs } from './inputFormatter.js';
import { formatCoinbaseInputs, formatOidcInputs } from './inputFormatter.js';
import { createLogger } from '../logger.js';

const log = createLogger('Prover');

const execFileAsync = promisify(execFile);

// Circuit ID to metadata mapping (directory name uses hyphens, package name uses underscores)
const CIRCUIT_META: Record<string, { dir: string; packageName: string }> = {
  coinbase_attestation: { dir: 'coinbase-attestation', packageName: 'coinbase_attestation' },
  coinbase_country_attestation: { dir: 'coinbase-country-attestation', packageName: 'coinbase_country_attestation' },
  oidc_domain_attestation: { dir: 'oidc-domain-attestation', packageName: 'oidc_domain_attestation' },
};

export interface BbProveResult {
  proof: string;           // hex-encoded proof (0x-prefixed)
  publicInputs: string;    // hex-encoded public inputs (0x-prefixed)
  proofWithInputs: string; // concatenated for on-chain submission (0x-prefixed)
}

export class BbProver {
  constructor(
    private config: {
      bbPath: string;
      circuitsDir: string;
    }
  ) {}

  /**
   * Generate a ZK proof for the given circuit using noir_js for witness generation.
   *
   * Flow:
   * 1. Load compiled circuit JSON
   * 2. Format inputs as noir_js-compatible JS object
   * 3. Execute circuit via noir_js to get compressed witness
   * 4. Write witness to temp file
   * 5. Run bb prove with the witness
   * 6. Off-chain verify
   * 7. Return proof + public inputs
   *
   * @param circuitId - Canonical circuit ID
   * @param inputs - Structured circuit inputs (CircuitParams for coinbase, OidcCircuitInputs for OIDC).
   */
  async prove(circuitId: string, inputs: Record<string, any>): Promise<BbProveResult> {
    const meta = CIRCUIT_META[circuitId];
    if (!meta) {
      throw new Error(`Unknown circuit ID: ${circuitId}`);
    }

    // Create temp directory for proof artifacts
    const workDir = path.join(os.tmpdir(), `proofport-${crypto.randomUUID()}`);
    const proofDir = path.join(workDir, 'proof');
    await fs.mkdir(proofDir, { recursive: true });

    try {
      // 1. Load compiled circuit JSON
      const circuitJsonPath = path.join(this.config.circuitsDir, meta.dir, 'target', `${meta.packageName}.json`);
      const circuitJson = JSON.parse(await fs.readFile(circuitJsonPath, 'utf-8'));

      // 2. Build noir_js-compatible inputs
      let noirInputs: Record<string, unknown>;
      if (circuitId === 'oidc_domain_attestation') {
        // OIDC: inputs is OidcProvePayload { jwt, jwks, scope, provider } — validate + build circuit inputs
        const { prepareOidcCircuitInputs } = await import('./oidcProver.js');
        const oidcInputs = prepareOidcCircuitInputs(inputs as any);
        noirInputs = formatOidcInputs(oidcInputs);
      } else {
        noirInputs = formatCoinbaseInputs(
          circuitId as 'coinbase_attestation' | 'coinbase_country_attestation',
          inputs as CircuitParams,
        );
      }

      // 3. Execute circuit via noir_js to generate witness
      const noir = new Noir(circuitJson);
      let witnessData: Uint8Array;
      try {
        const { witness } = await noir.execute(noirInputs as any);
        witnessData = witness;
      } catch (error: any) {
        throw new Error(`noir_js execute failed: ${error.message || error}`);
      }

      // 4. Write compressed witness to temp file
      const witnessPath = path.join(workDir, 'witness.gz');
      await fs.writeFile(witnessPath, witnessData);

      // 5. Run bb prove
      const vkPath = path.join(this.config.circuitsDir, meta.dir, 'target', 'vk', 'vk');
      try {
        await execFileAsync(
          this.config.bbPath,
          [
            'prove',
            '-b',
            circuitJsonPath,
            '-w',
            witnessPath,
            '-k',
            vkPath,
            '-o',
            proofDir,
            '--oracle_hash',
            'keccak',
          ],
          {
            timeout: 120000,
          }
        );
      } catch (error: any) {
        const stderr = error.stderr || error.message || 'Unknown error';
        throw new Error(`bb prove failed: ${stderr}`);
      }

      // 6. Off-chain verify before returning
      const verifyProofPath = path.join(proofDir, 'proof');
      const verifyPubInputsPath = path.join(proofDir, 'public_inputs');
      const isValid = await this.verify(circuitId, verifyProofPath, verifyPubInputsPath, vkPath);
      if (!isValid) {
        throw new Error('Off-chain proof verification failed');
      }

      // 7. Read proof output
      const proofBytes = await fs.readFile(verifyProofPath);
      const proof = '0x' + proofBytes.toString('hex');

      // 8. Read public inputs
      const publicInputsBytes = await fs.readFile(verifyPubInputsPath);
      const publicInputs = '0x' + publicInputsBytes.toString('hex');

      // 9. Concatenate for on-chain submission
      const proofWithInputs = proof + publicInputs.slice(2);

      return {
        proof,
        publicInputs,
        proofWithInputs,
      };
    } finally {
      // Always clean up temp dir
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async verify(circuitId: string, proofPath: string, publicInputsPath: string, vkPath: string): Promise<boolean> {
    try {
      await execFileAsync(
        this.config.bbPath,
        ['verify', '-p', proofPath, '-i', publicInputsPath, '-k', vkPath, '--oracle_hash', 'keccak'],
        {
          timeout: 30000,
        }
      );
      return true;
    } catch (error: any) {
      log.error({ action: 'prover.bb.verify_failed', detail: error.stderr || error.message }, 'bb verify failed');
      return false;
    }
  }
}
