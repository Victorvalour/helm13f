#!/usr/bin/env tsx
// Apply pending SQL migrations to the database referenced by DATABASE_URL.
// Usage: pnpm migrate

import { join } from 'node:path';
import { createPgDatabase, migrate } from '../src/db/index.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('migrate: DATABASE_URL not set');
    process.exit(1);
  }
  const db = createPgDatabase({ connectionString: url });
  try {
    const dir = join(process.cwd(), 'migrations');
    const applied = await migrate(db, {
      dir,
      logger: (e) => {
        if (e.kind === 'apply') console.log(`apply ${e.name ?? ''}`);
        else if (e.kind === 'skip') console.log(`skip  ${e.name ?? ''}`);
      },
    });
    console.log(`done — applied ${applied.length} migration(s)`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('migrate failed:', err);
  process.exit(1);
});
