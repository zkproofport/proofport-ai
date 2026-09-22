import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const exec = promisify(execFile);

/** Only a missing exact release of our SDK/MCP can be publication propagation. */
export function missingPublishedRelease(error, versions) {
  const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  for (const [name, version] of Object.entries(versions)) {
    if (!['@zkproofport-ai/sdk', '@zkproofport-ai/mcp'].includes(name)) continue;
    const spec = `${name}@${version}`;
    if (/\bETARGET\b/.test(output) && output.includes(`No matching version found for ${spec}.`)) return spec;
    if (/\bE404\b/.test(output) && output.includes(`'${spec}' is not in this registry`)) return spec;
  }
  return null;
}

export async function installPublishedPackages(cwd, versions, {
  execute = exec, wait = sleep, report = console.warn, maxAttempts = 5, delayMs = 15_000,
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-online'], {
        cwd, env: process.env, maxBuffer: 8 * 1024 * 1024, timeout: 120_000,
      });
    } catch (error) {
      const missing = missingPublishedRelease(error, versions);
      if (!missing || attempt === maxAttempts) throw error;
      report(`[published E2E] Registry has not exposed ${missing} to npm install yet; retry ${attempt + 1}/${maxAttempts} in ${delayMs / 1000}s.`);
      await wait(delayMs);
    }
  }
  throw new Error('Published package installation requires at least one attempt');
}
