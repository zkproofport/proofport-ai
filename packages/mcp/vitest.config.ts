import { defineConfig } from 'vitest/config';

// Mirrors the shape of the repo-root vitest.config.ts: two named projects so a
// CI job can run `--project unit` without ever needing a backend.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    projects: [
      // ── E2E tests: spawn the MCP server and hit a real backend ───────────
      // Serialized: every file drives the same stdio server and the same
      // backend, so parallel files contend for the nonce/Redis state.
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          globals: true,
          environment: 'node',
          fileParallelism: false,
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
        },
      },

      // ── Unit tests: mocked SDK, no network, run in parallel ──────────────
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/e2e/**/*.test.ts'],
          globals: true,
          environment: 'node',
        },
      },
    ],
  },
});
