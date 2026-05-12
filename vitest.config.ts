// Vitest config — split unit suite (default `pnpm test`) from the e2e
// suite (`pnpm test:e2e`) which requires Postgres up via docker-compose.
//
// Convention: any test file under tests/e2e/ or matching *.e2e.test.ts
// is excluded from the default run.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default: exclude e2e tests so `pnpm test` runs offline + fast.
    exclude: ['**/node_modules/**', '**/dist/**', '**/tests/e2e/**', '**/*.e2e.test.ts'],
  },
});
