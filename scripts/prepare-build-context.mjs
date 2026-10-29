#!/usr/bin/env node
/**
 * Build this repository's working tree into an allowlisted, hash-pinned build
 * context, with the circuit artifacts read from a circuits checkout beside it.
 *
 *   <root>/proofport-ai   this repository
 *   <root>/circuits       zkproofport/circuits at the commit to bake in
 *
 *   node proofport-ai/scripts/prepare-build-context.mjs --prepare
 *
 * `.github/workflows/emergency-deploy.yml` runs it and builds the image from
 * the context. It is the monorepo's scripts/deploy-ai-recording-gcp.mjs with
 * only the two roots changed (that script lives in the monorepo, beside the
 * proofport-ai and circuits submodules, and deploy-ai.yml runs it); keep the
 * two in step, or the two workflows bake different images from one commit.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ai = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(ai);
const project = 'masselabs-zkproofport';
const service = 'proofport-ai-staging';
const canonicalUrl = 'https://stg-ai.zkproofport.app';
const argv = process.argv.slice(2);
const mode = argv.shift();
if (mode !== '--prepare' || argv.length) {
  console.error('Usage: node proofport-ai/scripts/prepare-build-context.mjs --prepare');
  process.exit(1);
}

function capture(command, args, cwd = root) {
  try { return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`${command} failed: ${String(error.stderr ?? error.message).trim()}`); }
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const forbidden = /(^|\/)(\.env[^/]*|\.git|node_modules|credentials?[^/]*|secrets?[^/]*)(\/|$)|\.(pem|key|p8|p12|pfx|jks)$/i;
const privateKeyHeader = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const workParent = path.join(root, '.secrets-tmp');
await fs.mkdir(workParent, { recursive: true, mode: 0o700 });
const work = await fs.mkdtemp(path.join(workParent, 'gcp-ai-recording-'));
const context = path.join(work, 'context');
await fs.mkdir(context, { mode: 0o700 });
const files = [];
async function copyFile(source, relative) {
  if (forbidden.test(relative)) throw new Error(`Forbidden build input: ${relative}`);
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Build inputs must be regular files: ${relative}`);
  const bytes = await fs.readFile(source);
  if (privateKeyHeader.test(bytes.toString('utf8'))) throw new Error(`Private key content in build input: ${relative}`);
  const destination = path.join(context, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes, { mode: stat.mode & 0o777 });
  files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
}
async function copyTree(relative, extensions, excluded = new Set()) {
  async function visit(directory) {
    const stat = await fs.lstat(path.join(ai, directory));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Build source must be a regular directory: ${directory}`);
    for (const entry of await fs.readdir(path.join(ai, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (excluded.has(name)) continue;
      if (forbidden.test(name) || entry.name.startsWith('.')) throw new Error(`Unexpected hidden/secret input in allowlisted source: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile() && extensions.has(path.extname(name))) await copyFile(path.join(ai, name), name);
      else throw new Error(`Unexpected file in allowlisted source: ${name}`);
    }
  }
  await visit(relative);
}
for (const name of ['Dockerfile', 'package.json', 'package-lock.json', 'tsconfig.json', 'packages/sdk/package.json', 'packages/mcp/package.json',
  'packages/approval-web/package.json', 'packages/approval-web/tsconfig.json', 'packages/approval-web/vite.config.ts', 'packages/approval-web/index.html']) await copyFile(path.join(ai, name), name);
await copyTree('src', new Set(['.ts', '.json']));
// Bundle the approval page in the image from its exact source inputs. Host
// generated output, workspace dependencies/tests and local env files are not inputs.
await copyTree('packages/approval-web/src', new Set(['.ts', '.css']));
await copyTree('public', new Set(['.png', '.svg', '.ico', '.webp', '.jpg', '.jpeg', '.html', '.css', '.js']), new Set(['public/approval']));
await copyTree('aws', new Set(['.sh', '.py', '.yml', '.service', '.conf', '.enclave', '']));
// Ask the same circuit map the server uses; never maintain a second circuit list.
const circuitLines = capture(path.join(ai, 'node_modules/.bin/tsx'), ['scripts/print-circuit-dirs.ts'], ai).trim().split('\n');
const artifactHashes = {};
for (const line of circuitLines) {
  // `<directory> <artifact> <circuit id>`. The manifest is keyed by circuit
  // id, which the server looks up; the artifact name can differ from it
  // (coinbase_attestation is coinbase_attestation_v2.json), and keying by
  // artifact made the first v2 staging revision refuse to start (2026-10-28).
  const match = /^([a-z0-9-]+) ([a-z0-9_]+) ([a-z0-9_]+)$/.exec(line);
  if (!match) throw new Error(`Invalid canonical circuit entry: ${line}`);
  const [, directory, artifact, circuitId] = match;
  if (Object.hasOwn(artifactHashes, circuitId)) throw new Error(`Circuit ${circuitId} is listed twice`);
  for (const file of [`${artifact}.json`, 'vk/vk']) {
    await copyFile(path.join(root, 'circuits', directory, 'target', file), `circuits/${directory}/target/${file}`);
  }
  artifactHashes[circuitId] = {
    jsonHash: files.find(file => file.path === `circuits/${directory}/target/${artifact}.json`).sha256,
    vkHash: files.find(file => file.path === `circuits/${directory}/target/vk/vk`).sha256,
  };
}
const artifactManifest = Buffer.from(JSON.stringify(artifactHashes, null, 2));
await fs.writeFile(path.join(context, 'circuits/artifacts-meta.json'), artifactManifest);
files.push({ path: 'circuits/artifacts-meta.json', bytes: artifactManifest.length, sha256: sha256(artifactManifest) });
const ignore = '.git\n.env\n.env.*\n**/.env\n**/.env.*\n**/node_modules\n**/*.pem\n**/*.key\n**/*.p8\n';
await fs.writeFile(path.join(context, '.gcloudignore'), ignore);
await fs.writeFile(path.join(context, '.dockerignore'), ignore);
for (const name of ['.gcloudignore', '.dockerignore']) files.push({ path: name, bytes: Buffer.byteLength(ignore), sha256: sha256(ignore) });
files.sort((a, b) => a.path.localeCompare(b.path));
const sourceDigest = sha256(JSON.stringify(files));
const manifest = { createdAt: new Date().toISOString(), project, service, canonicalUrl, sourceDigest, files };
await fs.writeFile(path.join(work, 'source-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ mode, context: path.relative(root, context), sourceDigest, files: files.length, circuits: circuitLines.length }));
