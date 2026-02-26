import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CircuitParams } from '../input/inputBuilder.js';
import { toProverToml } from './tomlBuilder.js';
import { createWorkDir, cleanupWorkDir } from '../circuit/artifactManager.js';
import { createLogger } from '../logger.js';

const log = createLogger('Prover');

const execFileAsync = promisify(execFile);

// Circuit ID to package name mapping
const CIRCUIT_PACKAGES: Record<string, string> = {
  coinbase_attestation: 'coinbase_attestation',
  coinbase_country_attestation: 'coinbase_country_attestation',
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
      nargoPath: string;
      circuitsDir: string;
    }
  ) {}

  async prove(circuitId: string, params: CircuitParams): Promise<BbProveResult> {
    const packageName = CIRCUIT_PACKAGES[circuitId];
    if (!packageName) {
      throw new Error(`Unknown circuit ID: ${circuitId}`);
    }

    // 1. Create isolated temp working directory
    const workDir = await createWorkDir(this.config.circuitsDir, circuitId);

    try {
      // 2. Write Prover.toml to workDir
      const proverTomlContent = toProverToml(
        circuitId as 'coinbase_attestation' | 'coinbase_country_attestation',
        params
      );
      await fs.writeFile(path.join(workDir, 'Prover.toml'), proverTomlContent);

      // 3. Run nargo execute witness
      try {
        await execFileAsync(this.config.nargoPath, ['execute', 'witness'], {
          cwd: workDir,
          timeout: 120000,
        });
      } catch (error: any) {
        const stderr = error.stderr || error.message || 'Unknown error';
        throw new Error(`nargo execute failed: ${stderr}`);
      }

      // 4. Move witness file: target/witness.gz → target/proof/witness.gz
      const witnessSource = path.join(workDir, 'target', 'witness.gz');
      const witnessDest = path.join(workDir, 'target', 'proof', 'witness.gz');
      await fs.rename(witnessSource, witnessDest);

      // 5. Run bb prove
      try {
        await execFileAsync(
          this.config.bbPath,
          [
            'prove',
            '-b',
            `target/${packageName}.json`,
            '-w',
            'target/proof/witness.gz',
            '-k',
            'target/vk/vk',
            '-o',
            'target/proof',
            '--oracle_hash',
            'keccak',
          ],
          {
            cwd: workDir,
            timeout: 120000,
          }
        );
      } catch (error: any) {
        const stderr = error.stderr || error.message || 'Unknown error';
        throw new Error(`bb prove failed: ${stderr}`);
      }

      // 6. Off-chain verify before returning
      const verifyProofPath = path.join(workDir, 'target', 'proof', 'proof');
      const verifyPubInputsPath = path.join(workDir, 'target', 'proof', 'public_inputs');
      const verifyVkPath = path.join(workDir, 'target', 'vk', 'vk');
      const isValid = await this.verify(circuitId, verifyProofPath, verifyPubInputsPath, verifyVkPath);
      if (!isValid) {
        throw new Error('Off-chain proof verification failed');
      }

      // 7. Read proof output
      const proofPath = path.join(workDir, 'target', 'proof', 'proof');
      const proofBytes = await fs.readFile(proofPath);
      const proof = '0x' + proofBytes.toString('hex');

      // 8. Read public inputs
      const publicInputsPath = path.join(workDir, 'target', 'proof', 'public_inputs');
      const publicInputsBytes = await fs.readFile(publicInputsPath);
      const publicInputs = '0x' + publicInputsBytes.toString('hex');

      // 9. Concatenate for on-chain submission
      const proofWithInputs = proof + publicInputs.slice(2);

      return {
        proof,
        publicInputs,
        proofWithInputs,
      };
    } finally {
      // 10. Always clean up workDir
      await cleanupWorkDir(workDir);
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
