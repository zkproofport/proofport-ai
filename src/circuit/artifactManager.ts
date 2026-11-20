import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { CIRCUIT_DIRS } from '../config/circuitIds.js';

/**
 * The circuit artifacts baked into the image, checked before serving.
 *
 * Nothing here downloads. Until 2026-11-17 the server, unless
 * CIRCUITS_AUTO_UPDATE=false, compared every circuit with
 * circuits `main` on raw.githubusercontent.com on boot and fetched
 * `main` over any circuit that differed -- so a merge to circuits `main`
 * changed what a freshly started server proved with, with no deploy. The
 * AWS workflow never set the variable. The artifacts now come only from the
 * pinned circuits commit (src/config/circuitsPin.ts), copied in at build time
 * and stamped (src/circuit/circuitsSource.ts).
 */

interface ArtifactHashEntry {
  jsonHash: string;
  vkHash: string;
}

type ArtifactsMeta = Record<string, ArtifactHashEntry>;

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function loadMeta(circuitsDir: string): Promise<ArtifactsMeta> {
  const metaPath = path.join(circuitsDir, 'artifacts-meta.json');
  try {
    return JSON.parse(await fs.readFile(metaPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * CIRCUITS_AUTO_UPDATE is accepted only absent or `false`. `true` used to
 * mean "fetch circuits main over the baked artifacts"; that path is gone, and
 * a deployment still asking for it is told so rather than ignored.
 */
function checkAutoUpdateSetting(): void {
  const setting = process.env.CIRCUITS_AUTO_UPDATE;
  if (setting === undefined || setting === 'false') return;
  if (setting === 'true') {
    throw new Error(
      'CIRCUITS_AUTO_UPDATE=true is no longer supported: circuit artifacts are baked from the pinned circuits ' +
      'commit (src/config/circuitsPin.ts) and never downloaded. Unset it or set it to false.',
    );
  }
  throw new Error(`CIRCUITS_AUTO_UPDATE must be false or unset (got: ${setting})`);
}

/**
 * Every circuit's compiled JSON and verification key must be present, match
 * the hashes recorded when they were baked (artifacts-meta.json), be a
 * compiled Noir program, and have been compiled by `nargoVersion` -- the
 * NARGO_VERSION of the circuits tree they came from.
 */
export async function ensureArtifacts(circuitsDir: string, nargoVersion: string): Promise<void> {
  checkAutoUpdateSetting();
  if (!nargoVersion) throw new Error('ensureArtifacts needs the nargo version the artifacts were built with');
  const meta = await loadMeta(circuitsDir);
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
    // nargo writes `<version>+<commit>`.
    const compiler = typeof compiled.noir_version === 'string' ? compiled.noir_version.split('+')[0] : undefined;
    if (compiler !== nargoVersion) {
      throw new Error(
        `${circuitId} was compiled by nargo ${compiler ?? '(unrecorded)'}, but its circuits tree names nargo ${nargoVersion}`,
      );
    }
  }
}

/**
 * Get the path to a circuit's shared artifact directory
 */
export function getCircuitArtifactDir(circuitsDir: string, circuitId: string): string {
  return path.join(circuitsDir, circuitId);
}
