/**
 * A deployed service is tested with the packages customers install, never with
 * this checkout's source.
 *
 * Under the workspace config `@zkproofport-ai/sdk` resolves to `packages/sdk`
 * here. That is right for a server on this Mac and wrong for staging or
 * production: on 2026-10-13 staging payments were reported as passing while the
 * SDK under test was the local source, before 0.4.0 existed on npm.
 *
 * vitest.published.config.ts (used by `npm run test:e2e:published` and by
 * `scripts/run-e2e.sh --remote`) aliases the SDK to a registry install and does
 * not load this file.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const target = process.env.E2E_BASE_URL || 'http://localhost:4002';
const host = new URL(target).hostname;
if (!LOCAL_HOSTS.has(host)) {
  throw new Error(
    `E2E target ${target} is a deployment, and this run would test it with the local SDK source. ` +
    'Use the published packages: E2E_BASE_URL=' + target + ' npm run test:e2e:published ' +
    '(or scripts/run-e2e.sh --remote).',
  );
}
