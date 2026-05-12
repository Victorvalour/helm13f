// E2E vitest config — runs the docker-Postgres-requiring suite under
// tests/e2e/. The default config excludes these; `pnpm test:e2e` points
// vitest at this file instead.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Each e2e file owns its DB connection in beforeAll; serialise across
    // files so they don't race on the shared schema during reset().
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
