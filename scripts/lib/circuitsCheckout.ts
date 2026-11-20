/**
 * Describe a circuits checkout as the stamp the server checks at boot
 * (src/circuit/circuitsSource.ts), refusing what a deploy must not bake.
 *
 *   pinned  the checkout's HEAD must be the pinned commit and every artifact
 *           this server proves with, plus toolchain.env, must be exactly as
 *           committed there. Anything else is an error. Every deploy uses it.
 *   local   the same when it holds; otherwise the stamp says `worktree: true`
 *           and `reason` says why (a local run on uncommitted artifacts, e.g.
 *           a toolchain move). The server refuses such a stamp on mainnet.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CIRCUIT_DIRS } from '../../src/config/circuitIds.js';
import { parseToolchainEnv, type CircuitsStamp } from '../../src/circuit/circuitsSource.js';

export type CheckoutMode = 'pinned' | 'local';

export function parseCheckoutMode(value: string | undefined): CheckoutMode {
  if (value === 'pinned' || value === 'local') return value;
  throw new Error(`--mode must be pinned or local (got: ${value ?? '(missing)'})`);
}

function git(checkout: string, args: string[]): string {
  return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The files a stamp vouches for, relative to the checkout. */
export function stampedPaths(): string[] {
  const files = ['toolchain.env'];
  for (const { dir, packageName } of Object.values(CIRCUIT_DIRS)) {
    files.push(`${dir}/target/${packageName}.json`, `${dir}/target/vk/vk`);
  }
  return files;
}

export function describeCheckout(
  checkout: string,
  mode: CheckoutMode,
  pin: string,
): { stamp: CircuitsStamp; reason?: string } {
  if (!/^[0-9a-f]{40}$/.test(pin)) throw new Error(`The circuits pin must be a 40-hex commit (got: ${pin})`);
  const files = stampedPaths();
  const missing = files.filter(file => !fs.existsSync(path.join(checkout, file)));
  if (missing.length) throw new Error(`The circuits checkout ${checkout} has no ${missing.join(', ')}`);

  const head = git(checkout, ['rev-parse', 'HEAD']).trim();
  const changed = git(checkout, ['status', '--porcelain', '--untracked-files=all', '--', ...files])
    .split('\n').filter(Boolean);
  const toolchain = parseToolchainEnv(fs.readFileSync(path.join(checkout, 'toolchain.env'), 'utf8'));

  const problems: string[] = [];
  if (head !== pin) problems.push(`the checkout is at ${head}, the pin (src/config/circuitsPin.ts) is ${pin}`);
  if (changed.length) problems.push(`these differ from that commit: ${changed.map(line => line.slice(3)).join(', ')}`);

  if (problems.length && mode === 'pinned') {
    throw new Error(`Refusing to bake circuits that are not the pinned commit: ${problems.join('; ')}`);
  }
  return {
    stamp: { commit: head, worktree: problems.length > 0, ...toolchain },
    ...(problems.length ? { reason: problems.join('; ') } : {}),
  };
}
