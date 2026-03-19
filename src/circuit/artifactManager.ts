import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// Circuit metadata mapping
const CIRCUIT_META: Record<string, { repoDir: string; packageName: string }> = {
  coinbase_attestation: { repoDir: 'coinbase-attestation', packageName: 'coinbase_attestation' },
  coinbase_country_attestation: { repoDir: 'coinbase-country-attestation', packageName: 'coinbase_country_attestation' },
  oidc_domain_attestation: { repoDir: 'oidc-domain-attestation', packageName: 'oidc_domain_attestation' },
};

const DEFAULT_REPO_BASE_URL = 'https://raw.githubusercontent.com/zkproofport/circuits/main';

interface ArtifactHashEntry {
  jsonHash: string;
  vkHash: string;
  downloadedAt: string;
}

type ArtifactsMeta = Record<string, ArtifactHashEntry>;

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function loadMeta(circuitsDir: string): Promise<ArtifactsMeta> {
  const metaPath = path.join(circuitsDir, 'artifacts-meta.json');
  try {
    const raw = await fs.readFile(metaPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveMeta(circuitsDir: string, meta: ArtifactsMeta): Promise<void> {
  const metaPath = path.join(circuitsDir, 'artifacts-meta.json');
  await fs.mkdir(circuitsDir, { recursive: true });
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
}

async function fetchRemoteHash(url: string, type: 'text' | 'binary'): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  if (type === 'binary') {
    const buffer = Buffer.from(await response.arrayBuffer());
    return sha256(buffer);
  }
  const content = await response.text();
  return sha256(content);
}

/**
 * Download circuit artifacts (compiled JSON + VK) from GitHub.
 * Stores per-circuit SHA-256 hashes in artifacts-meta.json for integrity checking.
 */
export async function downloadArtifacts(circuitsDir: string, repoBaseUrl: string): Promise<void> {
  const meta = await loadMeta(circuitsDir);

  for (const [circuitId, cirMeta] of Object.entries(CIRCUIT_META)) {
    const targetDir = path.join(circuitsDir, cirMeta.repoDir, 'target');
    const vkDir = path.join(targetDir, 'vk');
    await fs.mkdir(vkDir, { recursive: true });

    const jsonUrl = `${repoBaseUrl}/${cirMeta.repoDir}/target/${cirMeta.packageName}.json`;
    const jsonPath = path.join(targetDir, `${cirMeta.packageName}.json`);
    await downloadFile(jsonUrl, jsonPath, 'text');

    const vkUrl = `${repoBaseUrl}/${cirMeta.repoDir}/target/vk/vk`;
    const vkPath = path.join(vkDir, 'vk');
    await downloadFile(vkUrl, vkPath, 'binary');

    const jsonContent = await fs.readFile(jsonPath);
    const vkContent = await fs.readFile(vkPath);

    meta[circuitId] = {
      jsonHash: sha256(jsonContent),
      vkHash: sha256(vkContent),
      downloadedAt: new Date().toISOString(),
    };
  }

  await saveMeta(circuitsDir, meta);
}

/**
 * Download artifacts if missing or if remote files have changed (hash mismatch).
 */
export async function ensureArtifacts(circuitsDir: string, repoBaseUrl?: string): Promise<void> {
  const baseUrl = repoBaseUrl || DEFAULT_REPO_BASE_URL;
  const meta = await loadMeta(circuitsDir);

  const toDownload: string[] = [];

  for (const [circuitId, cirMeta] of Object.entries(CIRCUIT_META)) {
    const jsonPath = path.join(circuitsDir, cirMeta.repoDir, 'target', `${cirMeta.packageName}.json`);
    const vkPath = path.join(circuitsDir, cirMeta.repoDir, 'target', 'vk', 'vk');

    // Check if files exist
    try {
      await fs.access(jsonPath);
      await fs.access(vkPath);
    } catch {
      toDownload.push(circuitId);
      continue;
    }

    // Check hash integrity against remote
    const stored = meta[circuitId];
    if (!stored) {
      toDownload.push(circuitId);
      continue;
    }

    try {
      const remoteJsonHash = await fetchRemoteHash(
        `${baseUrl}/${cirMeta.repoDir}/target/${cirMeta.packageName}.json`,
        'text',
      );
      if (remoteJsonHash !== stored.jsonHash) {
        toDownload.push(circuitId);
      }
    } catch {
      // If remote check fails, keep existing artifacts
    }
  }

  if (toDownload.length > 0) {
    // Re-download all artifacts to keep them in sync
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
