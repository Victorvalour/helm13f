// E2E test harness — connects to the docker-compose Postgres at
// DATABASE_URL, runs migrations, and provides truncate/cleanup helpers.
//
// Requires `pnpm db:up` (or any reachable Postgres). The `test:e2e`
// script in package.json defaults DATABASE_URL to the docker-compose
// connection string.

import { join } from 'node:path';
import { createPgDatabase, type Database, migrate } from '../../src/db/index.js';

export interface E2EHarness {
  db: Database;
  /** Truncates every domain table (preserves schema). Call before each test. */
  reset: () => Promise<void>;
  /** Closes the connection pool. */
  close: () => Promise<void>;
}

/**
 * Connect to DATABASE_URL + run migrations idempotently. Returns null
 * only when DATABASE_URL is unset (suite should skip). If DATABASE_URL
 * IS set but Postgres is unreachable, throws — that's a fail-loud signal
 * the operator forgot `pnpm db:up`.
 */
export async function connectAndMigrate(): Promise<E2EHarness | null> {
  const url = process.env['DATABASE_URL'];
  if (!url) return null;

  const db = createPgDatabase({ connectionString: url });
  try {
    await db.query('SELECT 1');
  } catch (err) {
    await db.close().catch(() => {});
    throw new Error(
      `e2e setup: DATABASE_URL is set (${url}) but Postgres is unreachable. ` +
        `Did you run 'pnpm db:up'? Underlying error: ${(err as Error).message}`,
    );
  }

  await migrate(db, {
    dir: join(process.cwd(), 'migrations'),
  });

  return {
    db,
    reset: async () => {
      // Order matters: holdings before filings; filings before filers;
      // delta_cache + ingestion_log + cusip_ticker_map are independent.
      await db.query(`
        TRUNCATE TABLE
          delta_cache,
          ingestion_log,
          cusip_ticker_map,
          holdings,
          filings,
          filers
        RESTART IDENTITY CASCADE
      `);
    },
    close: () => db.close(),
  };
}
