import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// Circuit metadata mapping
const CIRCUIT_META: Record<string, { repoDir: string; packageName: string }> = {
  coinbase_attestation: { repoDir: 'coinbase-attestation', packageName: 'coinbase_attestation' },
  coinbase_country_attestation: { repoDir: 'coinbase-country-attestation', packageName: 'coinbase_country_attestation' },
};

const COINBASE_LIBS_FILES = [
  'Nargo.toml',
  'src/lib.nr',
  'src/ethereum.nr',
  'src/merkle.nr',
  'src/nullifier.nr',
  'src/rlp.nr',
  'src/eip1559_tx_parser.nr',
];

const KECCAK256_FILES = [
  'Nargo.toml',
  'src/lib.nr',
  'src/keccak256.nr',
  'src/keccak256/tests.nr',
];

const DEFAULT_REPO_BASE_URL = 'https://raw.githubusercontent.com/zkproofport/circuits/main';

/**
 * Download all circuit artifacts from GitHub
 */
export async function downloadArtifacts(circuitsDir: string, repoBaseUrl: string): Promise<void> {
  for (const [circuitId, meta] of Object.entries(CIRCUIT_META)) {
    const targetDir = path.join(circuitsDir, circuitId, 'target');
    const vkDir = path.join(targetDir, 'vk');
    const srcDir = path.join(circuitsDir, circuitId, 'src');

    // Create directories
    await fs.mkdir(vkDir, { recursive: true });
    await fs.mkdir(srcDir, { recursive: true });

    // Download circuit JSON
    const jsonUrl = `${repoBaseUrl}/${meta.repoDir}/target/${meta.packageName}.json`;
    const jsonPath = path.join(targetDir, `${meta.packageName}.json`);
    await downloadFile(jsonUrl, jsonPath, 'text');

    // Download VK
    const vkUrl = `${repoBaseUrl}/${meta.repoDir}/target/vk/vk`;
    const vkPath = path.join(vkDir, 'vk');
    await downloadFile(vkUrl, vkPath, 'binary');

    // Download source file
    const mainNrUrl = `${repoBaseUrl}/${meta.repoDir}/src/main.nr`;
    const mainNrPath = path.join(srcDir, 'main.nr');
    await downloadFile(mainNrUrl, mainNrPath, 'text');
  }

  // Download coinbase-libs files (shared dependency)
  const coinbaseLibsDir = path.join(circuitsDir, 'coinbase-libs');
  const coinbaseLibsSrcDir = path.join(coinbaseLibsDir, 'src');
  await fs.mkdir(coinbaseLibsSrcDir, { recursive: true });

  for (const file of COINBASE_LIBS_FILES) {
    const fileUrl = `${repoBaseUrl}/coinbase-libs/${file}`;
    const filePath = path.join(coinbaseLibsDir, file);
    await downloadFile(fileUrl, filePath, 'text');
  }

  // Download keccak256 library (v0.1.1 tag)
  const keccak256Dir = path.join(circuitsDir, 'keccak256');
  await fs.mkdir(path.join(keccak256Dir, 'src', 'keccak256'), { recursive: true });

  const keccak256BaseUrl = 'https://raw.githubusercontent.com/noir-lang/keccak256/v0.1.1';
  for (const file of KECCAK256_FILES) {
    const fileUrl = `${keccak256BaseUrl}/${file}`;
    const filePath = path.join(keccak256Dir, file);
    await downloadFile(fileUrl, filePath, 'text');
  }
}

/**
 * Download only if not already present
 */
export async function ensureArtifacts(circuitsDir: string, repoBaseUrl?: string): Promise<void> {
  const baseUrl = repoBaseUrl || DEFAULT_REPO_BASE_URL;

  // Check if all artifacts exist
  let allExist = true;
  for (const [circuitId, meta] of Object.entries(CIRCUIT_META)) {
    const jsonPath = path.join(circuitsDir, circuitId, 'target', `${meta.packageName}.json`);
    const vkPath = path.join(circuitsDir, circuitId, 'target', 'vk', 'vk');
    const mainNrPath = path.join(circuitsDir, circuitId, 'src', 'main.nr');

    try {
      await fs.access(jsonPath);
      await fs.access(vkPath);
      await fs.access(mainNrPath);
    } catch {
      allExist = false;
      break;
    }
  }

  // Check coinbase-libs
  const coinbaseLibsPath = path.join(circuitsDir, 'coinbase-libs', 'src', 'lib.nr');
  try {
    await fs.access(coinbaseLibsPath);
  } catch {
    allExist = false;
  }

  // Check keccak256
  const keccak256Path = path.join(circuitsDir, 'keccak256', 'src', 'lib.nr');
  try {
    await fs.access(keccak256Path);
  } catch {
    allExist = false;
  }

  if (!allExist) {
    await downloadArtifacts(circuitsDir, baseUrl);
  }
}

/**
 * Get the path to a circuit's shared artifact directory
 */
export function getCircuitArtifactDir(circuitsDir: string, circuitId: string): string {
  return path.join(circuitsDir, circuitId);
}

/**
 * Create an isolated temp working directory for a single proof request
 * Creates symlinks to shared artifacts, writes Nargo.toml, creates target/proof/ dir
 */
export async function createWorkDir(circuitsDir: string, circuitId: string): Promise<string> {
  const meta = CIRCUIT_META[circuitId];
  if (!meta) {
    throw new Error(`Unknown circuit ID: ${circuitId}`);
  }

  // Create temp directory
  const workDir = path.join(os.tmpdir(), `proofport-${crypto.randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });

  try {
    // Create target directories
    const targetDir = path.join(workDir, 'target');
    const vkDir = path.join(targetDir, 'vk');
    const proofDir = path.join(targetDir, 'proof');
    await fs.mkdir(vkDir, { recursive: true });
    await fs.mkdir(proofDir, { recursive: true });

    // Write Nargo.toml with real dependencies using absolute paths
    const nargoToml = `[package]
name = "${meta.packageName}"
type = "bin"
compiler_version = ">= 1.0.0"

[dependencies]
keccak256 = { path = "${path.join(circuitsDir, 'keccak256')}" }
coinbase_libs = { path = "${path.join(circuitsDir, 'coinbase-libs')}" }
`;
    await fs.writeFile(path.join(workDir, 'Nargo.toml'), nargoToml);

    // Create symlink to src directory
    const sharedSrcDir = path.join(circuitsDir, circuitId, 'src');
    const workSrcDir = path.join(workDir, 'src');
    await fs.symlink(sharedSrcDir, workSrcDir);

    // Create symlinks to shared artifacts
    const sharedArtifactDir = path.join(circuitsDir, circuitId, 'target');
    const sharedJsonPath = path.join(sharedArtifactDir, `${meta.packageName}.json`);
    const sharedVkPath = path.join(sharedArtifactDir, 'vk', 'vk');

    const targetJsonPath = path.join(targetDir, `${meta.packageName}.json`);
    const targetVkPath = path.join(vkDir, 'vk');

    await fs.symlink(sharedJsonPath, targetJsonPath);
    await fs.symlink(sharedVkPath, targetVkPath);

    return workDir;
  } catch (error) {
    // Clean up on error
    await cleanupWorkDir(workDir);
    throw error;
  }
}

/**
 * Clean up a working directory after proof generation
 */
export async function cleanupWorkDir(workDir: string): Promise<void> {
  try {
    await fs.rm(workDir, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
}

/**
 * Helper function to download a file
 */
async function downloadFile(url: string, dest: string, type: 'text' | 'binary'): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  if (type === 'binary') {
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(dest, buffer);
  } else {
    const content = await response.text();
    await fs.writeFile(dest, content);
  }
}
