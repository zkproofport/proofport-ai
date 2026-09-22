import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

const entry = process.env.E2E_PUBLISHED_SDK_ENTRY;
if (!entry || !process.env.E2E_MCP_ENTRY) {
  throw new Error('Use node scripts/run-published-e2e.mjs to install and verify registry artifacts first');
}
// Each inline Vitest project gets the alias explicitly: project configs do
// not automatically inherit all root Vite options.
const resolve = { alias: [{ find: /^@zkproofport-ai\/sdk$/, replacement: entry }] };
export default defineConfig({
  ...base,
  resolve,
  test: {
    ...base.test,
    projects: [{
      resolve,
      test: {
        name: 'e2e', include: ['tests/e2e/**/*.test.ts'], globals: true,
        environment: 'node', setupFiles: ['./tests/setup.ts'], fileParallelism: false,
        poolOptions: { forks: { singleFork: true } },
      },
    }],
  },
});
