import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Circuit metadata mapping
const CIRCUIT_META: Record<string, { repoDir: string; packageName: string }> = {
  coinbase_attestation: { repoDir: 'coinbase-attestation', packageName: 'coinbase_attestation' },
  coinbase_country_attestation: { repoDir: 'coinbase-country-attestation', packageName: 'coinbase_country_attestation' },
  oidc_domain_attestation: { repoDir: 'oidc-domain-attestation', packageName: 'oidc_domain_attestation' },
};

const DEFAULT_REPO_BASE_URL = 'https://raw.githubusercontent.com/zkproofport/circuits/main';

/**
 * Download circuit artifacts (compiled JSON + VK) from GitHub.
 * No longer downloads source code or library dependencies — noir_js uses compiled JSON directly.
 */
export async function downloadArtifacts(circuitsDir: string, repoBaseUrl: string): Promise<void> {
  for (const [_circuitId, meta] of Object.entries(CIRCUIT_META)) {
    const targetDir = path.join(circuitsDir, meta.repoDir, 'target');
    const vkDir = path.join(targetDir, 'vk');

    // Create directories
    await fs.mkdir(vkDir, { recursive: true });

    // Download circuit JSON
    const jsonUrl = `${repoBaseUrl}/${meta.repoDir}/target/${meta.packageName}.json`;
    const jsonPath = path.join(targetDir, `${meta.packageName}.json`);
    await downloadFile(jsonUrl, jsonPath, 'text');

    // Download VK
    const vkUrl = `${repoBaseUrl}/${meta.repoDir}/target/vk/vk`;
    const vkPath = path.join(vkDir, 'vk');
    await downloadFile(vkUrl, vkPath, 'binary');
  }
}

/**
 * Download only if not already present
 */
export async function ensureArtifacts(circuitsDir: string, repoBaseUrl?: string): Promise<void> {
  const baseUrl = repoBaseUrl || DEFAULT_REPO_BASE_URL;

  // Check if all artifacts exist
  let allExist = true;
  for (const [_circuitId, meta] of Object.entries(CIRCUIT_META)) {
    const jsonPath = path.join(circuitsDir, meta.repoDir, 'target', `${meta.packageName}.json`);
    const vkPath = path.join(circuitsDir, meta.repoDir, 'target', 'vk', 'vk');

    try {
      await fs.access(jsonPath);
      await fs.access(vkPath);
    } catch {
      allExist = false;
      break;
    }
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
