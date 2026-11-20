import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { CIRCUITS_COMMIT } from '../config/circuitsPin.js';
import { ensureArtifacts } from './artifactManager.js';

/**
 * Where the circuit artifacts in an image came from, written next to them as
 * `circuits/circuits-source.json` by whatever baked them:
 * `scripts/circuits-source.ts` through the build context scripts (deploys,
 * always `worktree: false`) or `scripts/bake-circuits.sh` (local runs and the
 * AWS workflow).
 *
 *   commit        the circuits commit the artifacts were copied from
 *   worktree      true when they were copied from a working tree that is not
 *                 exactly that commit (uncommitted artifacts, or a commit
 *                 other than the pin) -- a local run, never a deploy
 *   nargoVersion  NARGO_VERSION of that tree's toolchain.env
 *   bbVersion     BB_VERSION of that tree's toolchain.env
 */
export interface CircuitsStamp {
  commit: string;
  worktree: boolean;
  nargoVersion: string;
  bbVersion: string;
}

export const CIRCUITS_STAMP_FILE = 'circuits-source.json';

/**
 * NARGO_VERSION and BB_VERSION from a circuits `toolchain.env`. A missing or
 * empty key is an error naming it -- never a version filled in from here.
 */
export function parseToolchainEnv(text: string): { nargoVersion: string; bbVersion: string } {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].trim();
  }
  for (const key of ['NARGO_VERSION', 'BB_VERSION']) {
    if (!values[key]) throw new Error(`toolchain.env has no ${key}`);
  }
  return { nargoVersion: values.NARGO_VERSION, bbVersion: values.BB_VERSION };
}

export function parseCircuitsStamp(raw: unknown): CircuitsStamp {
  if (!raw || typeof raw !== 'object') throw new Error(`${CIRCUITS_STAMP_FILE} is not a JSON object`);
  const value = raw as Record<string, unknown>;
  if (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit)) {
    throw new Error(`${CIRCUITS_STAMP_FILE}: commit must be a 40-hex circuits commit (got: ${String(value.commit)})`);
  }
  if (typeof value.worktree !== 'boolean') {
    throw new Error(`${CIRCUITS_STAMP_FILE}: worktree must be true or false (got: ${String(value.worktree)})`);
  }
  for (const key of ['nargoVersion', 'bbVersion'] as const) {
    if (typeof value[key] !== 'string' || !value[key]) {
      throw new Error(`${CIRCUITS_STAMP_FILE}: ${key} is missing`);
    }
  }
  return {
    commit: value.commit,
    worktree: value.worktree,
    nargoVersion: value.nargoVersion as string,
    bbVersion: value.bbVersion as string,
  };
}

export async function readCircuitsStamp(circuitsDir: string): Promise<CircuitsStamp> {
  const file = path.join(circuitsDir, CIRCUITS_STAMP_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch {
    throw new Error(
      `No ${file}: these artifacts do not say which circuits commit they came from. ` +
      'Bake them with scripts/bake-circuits.sh (local) or the build context scripts (deploys).',
    );
  }
  return parseCircuitsStamp(JSON.parse(text));
}

/**
 * The stamp against the pin.
 *
 * A pinned stamp must name CIRCUITS_COMMIT exactly. A worktree stamp (a local
 * run on uncommitted or unpinned artifacts) is accepted only when the server
 * does not take mainnet payment: the deploy build scripts never write one, and
 * this keeps a hand-built image from reaching production with one.
 */
export function checkCircuitsPin(stamp: CircuitsStamp, paymentMode: string, pin: string = CIRCUITS_COMMIT): void {
  if (stamp.worktree) {
    if (paymentMode === 'mainnet') {
      throw new Error(
        `The circuit artifacts were copied from a circuits working tree (${stamp.commit} plus local changes), ` +
        `which a mainnet server never proves with. Bake the pinned commit ${pin}.`,
      );
    }
    return;
  }
  if (stamp.commit !== pin) {
    throw new Error(
      `The image's circuit artifacts come from circuits ${stamp.commit}, but this server is pinned to ${pin} ` +
      '(src/config/circuitsPin.ts). Rebuild the image from the pinned commit, or move the pin.',
    );
  }
}

/**
 * The provers against the toolchain the artifacts were built with. bb and the
 * witness generator (noir_js) must be that set's exact versions: a bb 6 proof
 * is refused by a bb 4.2 key and its verifier, and the reverse.
 */
export function checkToolchain(stamp: CircuitsStamp, found: { bbVersion: string; noirJsVersion: string }): void {
  if (found.bbVersion !== stamp.bbVersion) {
    throw new Error(
      `bb reports ${found.bbVersion}, but the circuits at ${stamp.commit} were built with bb ${stamp.bbVersion} ` +
      '(their toolchain.env). Proofs from this bb would not verify against these keys.',
    );
  }
  if (found.noirJsVersion !== stamp.nargoVersion) {
    throw new Error(
      `@noir-lang/noir_js is ${found.noirJsVersion}, but the circuits at ${stamp.commit} were compiled by nargo ` +
      `${stamp.nargoVersion} (their toolchain.env).`,
    );
  }
}

export async function readBbVersion(bbPath: string): Promise<string> {
  const { stdout } = await promisify(execFile)(bbPath, ['--version'], { timeout: 30_000 });
  return stdout.trim();
}

/** The installed @noir-lang/noir_js version (its exports map hides package.json). */
export async function readNoirJsVersion(): Promise<string> {
  const entry = createRequire(import.meta.url).resolve('@noir-lang/noir_js');
  let directory = path.dirname(entry);
  for (;;) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf-8'));
      if (manifest.name === '@noir-lang/noir_js') return manifest.version;
    } catch { /* not this directory */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Could not find the package.json of @noir-lang/noir_js');
    directory = parent;
  }
}

/**
 * Everything the server checks about its circuits before serving: stamp, pin,
 * artifact hashes and compiler version, bb, noir_js. Any failure stops boot.
 */
export async function verifyCircuitsAtBoot(options: {
  circuitsDir: string;
  bbPath: string;
  paymentMode: string;
}): Promise<CircuitsStamp> {
  const stamp = await readCircuitsStamp(options.circuitsDir);
  checkCircuitsPin(stamp, options.paymentMode);
  await ensureArtifacts(options.circuitsDir, stamp.nargoVersion);
  checkToolchain(stamp, {
    bbVersion: await readBbVersion(options.bbPath),
    noirJsVersion: await readNoirJsVersion(),
  });
  return stamp;
}
