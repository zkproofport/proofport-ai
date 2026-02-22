import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/types/**',
        'src/tee/enclave/**',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
    projects: [
      // ── E2E tests: hit real Docker container at localhost:4002 ────────────
      // These MUST run sequentially — all files share one container and the
      // A2A task worker uses Redis, causing contention when files run in
      // parallel. fileParallelism:false + singleFork serializes execution.
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          globals: true,
          environment: 'node',
          setupFiles: ['./tests/setup.ts'],
          fileParallelism: false,
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
        },
      },

      // ── Unit / Integration tests: run in parallel (default behavior) ──────
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/e2e/**/*.test.ts'],
          globals: true,
          environment: 'node',
          setupFiles: ['./tests/setup.ts'],
        },
      },
    ],
  },
});
