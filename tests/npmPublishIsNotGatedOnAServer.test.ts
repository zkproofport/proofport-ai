/**
 * Publishing the SDK and MCP does not wait for a server deployment.
 *
 * The order is: publish the packages, deploy the server, test the deployment
 * with the published packages. The server builds from its own source and never
 * installs @zkproofport-ai/sdk or @zkproofport-ai/mcp, so nothing about a
 * deployment depends on them being on npm first.
 *
 * From 2026-09-23 to 2026-10-13 the publish job refused to run until PRODUCTION
 * reported the same version, with no override. That inverted the order: the
 * 0.4.0 release sat unpublished behind a production deploy nobody had asked
 * for, and every release turned into a request for production approval.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/npm-publish.yml', import.meta.url), 'utf8');

describe('npm publication', () => {
  it('runs no step that reads a deployed server', () => {
    expect(workflow).not.toMatch(/ai\.zkproofport\.app|stg-ai\.zkproofport\.app/);
    expect(workflow).not.toMatch(/readiness/i);
    expect(existsSync(new URL('../scripts/check-npm-release-readiness.mjs', import.meta.url))).toBe(false);
  });

  it('still publishes only from a Release Please tag', () => {
    expect(workflow).toMatch(/release_tag/);
    expect(workflow).toMatch(/npm publish/);
  });
});
