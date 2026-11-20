#!/usr/bin/env node
// Writes (or with --check, compares) packages/sdk/src/oprf/core/*.ts: a
// MIRROR of @zkproofport-app/core's dependency-free OPRF client
// (proofport-app-sdk/packages/core/src/oprf/). The published core this
// repository pins (0.4.0-beta.8) does not ship it; once a later core release
// does, delete the mirror and import `@zkproofport-app/core/oprf` instead.
//
// The only change made to each file is the import suffix ('./field' ->
// './field.js', which Node16 module resolution needs) and a header line naming
// the source. tests/oprfMirror.test.ts holds the mirror to the shared vectors
// (tests/fixtures/oprf-vectors.json, byte-identical to core's).
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

const check = process.argv.includes('--check');
for (const p of [CORE_OPRF, VECTORS_SRC]) {
  if (!existsSync(p)) {
    console.error(`missing ${p}: run from the proofport-app-dev monorepo with proofport-app-sdk checked out`);
    process.exit(1);
  }
}

const header = (file) =>
  `// MIRROR of proofport-app-sdk/packages/core/src/oprf/${file} (scripts/sync-oprf-mirror.mjs). Do not edit here.\n`;

const transform = (file, text) =>
  header(file) + text.replace(/(from\s+'\.\/[A-Za-z0-9_.]+?)(?<!\.js)'/g, "$1.js'");

let drift = 0;
if (!check) mkdirSync(MIRROR, { recursive: true });
const files = readdirSync(CORE_OPRF).filter(f => f.endsWith('.ts')).sort();
for (const file of files) {
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
const extra = existsSync(MIRROR) ? readdirSync(MIRROR).filter(f => !files.includes(f)) : [];
for (const f of extra) {
  console.error(`not in core: packages/sdk/src/oprf/core/${f}`);
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
  console.log(`mirror up to date (${files.length} files + vectors)`);
}
