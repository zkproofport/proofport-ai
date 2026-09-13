import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { CIRCUIT_IDS, CIRCUIT_DIRS } from '../config/circuitIds.js';
import type { CircuitId } from '../config/circuitIds.js';

/**
 * Where each circuit's artifacts live in the `zkproofport/circuits` repo.
 *
 * `repoDir` is a directory name and uses hyphens; `packageName` is the circuit's
 * canonical id and uses underscores. They are different strings on purpose —
 * only `packageName` is an identifier, and it comes from `CIRCUIT_IDS`.
 */


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
 *
 * `only` limits it to the circuits named. Without that it downloaded every
 * circuit whenever ANY one of them needed it -- so one circuit that is not on
 * the remote branch yet threw a 404 partway through and took the other three
 * with it, discarding local copies that were already correct. That is how the
 * local container refused to start on 2026-09-09 with three good circuits on
 * disk.
 */
export async function downloadArtifacts(
  circuitsDir: string,
  repoBaseUrl: string,
  only?: readonly string[],
): Promise<void> {
  const meta = await loadMeta(circuitsDir);

  for (const [circuitId, cirMeta] of Object.entries(CIRCUIT_DIRS)) {
    if (only && !only.includes(circuitId)) continue;
    const targetDir = path.join(circuitsDir, cirMeta.dir, 'target');
    const vkDir = path.join(targetDir, 'vk');
    await fs.mkdir(vkDir, { recursive: true });

    const jsonUrl = `${repoBaseUrl}/${cirMeta.dir}/target/${cirMeta.packageName}.json`;
    const jsonPath = path.join(targetDir, `${cirMeta.packageName}.json`);
    await downloadFile(jsonUrl, jsonPath, 'text');

    const vkUrl = `${repoBaseUrl}/${cirMeta.dir}/target/vk/vk`;
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
  const updateSetting = process.env.CIRCUITS_AUTO_UPDATE;
  if (updateSetting !== undefined && updateSetting !== 'true' && updateSetting !== 'false') {
    throw new Error(`CIRCUITS_AUTO_UPDATE must be true or false (got: ${updateSetting})`);
  }
  const baseUrl = repoBaseUrl || DEFAULT_REPO_BASE_URL;
  const meta = await loadMeta(circuitsDir);
  if (updateSetting === 'false') {
    for (const [circuitId, artifact] of Object.entries(CIRCUIT_DIRS)) {
      const directory = path.join(circuitsDir, artifact.dir, 'target');
      const json = await fs.readFile(path.join(directory, `${artifact.packageName}.json`));
      const vk = await fs.readFile(path.join(directory, 'vk/vk'));
      const expected = meta[circuitId];
      if (!expected || !/^[a-f0-9]{64}$/.test(expected.jsonHash) || !/^[a-f0-9]{64}$/.test(expected.vkHash)) {
        throw new Error(`Pinned artifact hashes are missing or invalid for ${circuitId}`);
      }
      if (sha256(json) !== expected.jsonHash || sha256(vk) !== expected.vkHash) {
        throw new Error(`Pinned artifact hash mismatch for ${circuitId}`);
      }
      const compiled = JSON.parse(json.toString('utf8'));
      if (!compiled || typeof compiled.bytecode !== 'string' || !compiled.bytecode.length ||
          !compiled.abi || !Array.isArray(compiled.abi.parameters) || vk.length === 0) {
        throw new Error(`Invalid compiled JSON or empty verification key for ${circuitId}`);
      }
    }
    return;
  }
  let metaChanged = false;

  const toDownload: string[] = [];

  for (const [circuitId, cirMeta] of Object.entries(CIRCUIT_DIRS)) {
    const jsonPath = path.join(circuitsDir, cirMeta.dir, 'target', `${cirMeta.packageName}.json`);
    const vkPath = path.join(circuitsDir, cirMeta.dir, 'target', 'vk', 'vk');

    // Check if files exist
    try {
      await fs.access(jsonPath);
      await fs.access(vkPath);
    } catch {
      toDownload.push(circuitId);
      continue;
    }

    // Both files are here. If nothing was recorded about them, they were put
    // there by hand -- `scripts/ai-dev.sh` copies them from the sibling
    // circuits repo, which is the documented way to run a circuit that has not
    // been pushed yet. Record what is on disk and accept it.
    //
    // Queuing a download instead, which is what this did, made the supported
    // dev path impossible: a circuit built locally and not yet pushed always
    // had no meta entry, so it was always fetched, and the fetch always 404ed.
    let stored = meta[circuitId];
    if (!stored) {
      const jsonContent = await fs.readFile(jsonPath);
      const vkContent = await fs.readFile(vkPath);
      stored = {
        jsonHash: sha256(jsonContent),
        vkHash: sha256(vkContent),
        downloadedAt: new Date().toISOString(),
      };
      meta[circuitId] = stored;
      metaChanged = true;
    }

    try {
      const remoteJsonHash = await fetchRemoteHash(
        `${baseUrl}/${cirMeta.dir}/target/${cirMeta.packageName}.json`,
        'text',
      );
      if (remoteJsonHash !== stored.jsonHash) {
        toDownload.push(circuitId);
      }
    } catch {
      // The remote does not have it, or is unreachable. Either way the local
      // copy is what we have and it is intact -- keep it rather than throwing
      // away a working circuit over a failed HEAD.
    }
  }

  if (metaChanged) {
    await saveMeta(circuitsDir, meta);
  }

  if (toDownload.length > 0) {
    // Only the circuits that need it. See downloadArtifacts for why "all of
    // them" was wrong.
    await downloadArtifacts(circuitsDir, baseUrl, toDownload);
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
