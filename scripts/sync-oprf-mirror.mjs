#!/usr/bin/env node
// Writes (or with --check, compares) packages/sdk/src/oprf/core/{field,babyjubjub}.ts:
// a MIRROR of the two arithmetic modules of @zkproofport-app/core's OPRF client
// (proofport-app-sdk/packages/core/src/oprf/).
//
// Everything else of that client is imported from `@zkproofport-app/core/oprf`
// since core 0.4.0-beta.9: the client (name rules, query, blinding, DLog check,
// unblinding, key hash, nullifier, finalizeOprf), Poseidon2 and keccak. Core
// does not export the field and curve arithmetic the threshold combination in
// packages/sdk/src/oprf/shamir.ts needs (mod, invMod, sqrtMod, legendre,
// toHex32, parseScalar, add, scalarMul, negate, the curve constants), so these
// two files stay mirrored until a core release exports them.
//
// Changes made to each file: the import suffix ('./field' -> './field.js',
// which Node16 module resolution needs), an import of a module core exports
// ('./poseidon2') pointed at '@zkproofport-app/core/oprf', and a header line
// naming the source. tests/oprfMirror.test.ts holds the client to the shared
// vectors (tests/fixtures/oprf-vectors.json, byte-identical to core's).
//
//   node scripts/sync-oprf-mirror.mjs           write the mirror from the sibling checkout
//   node scripts/sync-oprf-mirror.mjs --check   exit 1 when the mirror or the vectors drifted
//
// Needs the parent monorepo checkout (proofport-app-sdk next to proofport-ai).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const top = git('rev-parse', '--show-toplevel');
const superproject = git('rev-parse', '--show-superproject-working-tree');
const REPO = superproject || top;
const AI = join(REPO, 'proofport-ai');
const CORE_OPRF = join(REPO, 'proofport-app-sdk/packages/core/src/oprf');
const MIRROR = join(AI, 'packages/sdk/src/oprf/core');
const VECTORS_SRC = join(REPO, 'proofport-app-sdk/src/__tests__/fixtures/oprf-vectors.json');
const VECTORS_DST = join(AI, 'tests/fixtures/oprf-vectors.json');

/** The files core does not export. Anything else is imported from core. */
const MIRRORED = ['babyjubjub.ts', 'field.ts'];

/** Sibling modules the mirrored files import that core exports from its `./oprf` subpath. */
const FROM_CORE = { './poseidon2': '@zkproofport-app/core/oprf' };

const check = process.argv.includes('--check');
for (const p of [CORE_OPRF, VECTORS_SRC, ...MIRRORED.map(f => join(CORE_OPRF, f))]) {
  if (!existsSync(p)) {
    console.error(`missing ${p}: run from the proofport-app-dev monorepo with proofport-app-sdk checked out`);
    process.exit(1);
  }
}

const header = (file) =>
  `// MIRROR of proofport-app-sdk/packages/core/src/oprf/${file} (scripts/sync-oprf-mirror.mjs). Do not edit here.\n`;

function transform(file, text) {
  let out = text;
  for (const [from, to] of Object.entries(FROM_CORE)) {
    out = out.replaceAll(`from '${from}'`, `from '${to}'`);
  }
  out = out.replace(/(from\s+'\.\/[A-Za-z0-9_.]+?)(?<!\.js)'/g, "$1.js'");
  const local = [...out.matchAll(/from\s+'\.\/([A-Za-z0-9_]+)\.js'/g)].map(m => `${m[1]}.ts`);
  const missing = local.filter(f => !MIRRORED.includes(f));
  if (missing.length) {
    console.error(`${file} imports ${missing.join(', ')}, which is neither mirrored nor mapped to core in FROM_CORE`);
    process.exit(1);
  }
  return header(file) + out;
}

let drift = 0;
if (!check) mkdirSync(MIRROR, { recursive: true });
for (const file of MIRRORED) {
  const want = transform(file, readFileSync(join(CORE_OPRF, file), 'utf8'));
  const dst = join(MIRROR, file);
  const have = existsSync(dst) ? readFileSync(dst, 'utf8') : null;
  if (have === want) continue;
  if (check) {
    console.error(`drift: packages/sdk/src/oprf/core/${file}`);
    drift++;
  } else {
    writeFileSync(dst, want);
    console.log(`wrote packages/sdk/src/oprf/core/${file}`);
  }
}
const extra = existsSync(MIRROR) ? readdirSync(MIRROR).filter(f => !MIRRORED.includes(f)) : [];
for (const f of extra) {
  console.error(`not mirrored (import it from @zkproofport-app/core/oprf instead): packages/sdk/src/oprf/core/${f}`);
  drift++;
}
const vSrc = readFileSync(VECTORS_SRC);
const vDst = existsSync(VECTORS_DST) ? readFileSync(VECTORS_DST) : null;
if (!vDst || !vSrc.equals(vDst)) {
  if (check) {
    console.error('drift: tests/fixtures/oprf-vectors.json differs from core\'s');
    drift++;
  } else {
    writeFileSync(VECTORS_DST, vSrc);
    console.log('wrote tests/fixtures/oprf-vectors.json');
  }
}
if (check) {
  if (drift) process.exit(1);
  console.log(`mirror up to date (${MIRRORED.length} files + vectors)`);
}
