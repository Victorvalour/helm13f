// Migrations runner.
//
// Discovers .sql files under /migrations, sorts by filename, and applies
// any not yet recorded in the `_helm13f_migrations` table. Each file runs
// inside its own transaction; the BEGIN/COMMIT/ROLLBACK in the file
// itself is honoured. The runner only adds the post-success bookkeeping
// row recording the file's name and SHA-256.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database, QueryRunner } from './pool.js';
import { DbError } from './pool.js';

const MIGRATIONS_TABLE = '_helm13f_migrations';

export interface MigrationFile {
  name: string;
  sha256: string;
  sql: string;
}

export interface MigrationApplied {
  name: string;
  sha256: string;
  appliedAt: Date;
}

export interface MigrateOptions {
  /** Filesystem path containing the .sql files. */
  dir: string;
  /** Optional logger; default no-op. */
  logger?: (event: { kind: 'apply' | 'skip' | 'init'; name?: string }) => void;
}

/** Apply all pending migrations under `dir` against the given database. */
export async function migrate(db: Database, opts: MigrateOptions): Promise<MigrationApplied[]> {
  const files = await loadMigrationFiles(opts.dir);
  await ensureMigrationsTable(db);
  opts.logger?.({ kind: 'init' });

  const appliedRows = await db.query<{ name: string; sha256: string }>(
    `SELECT name, sha256 FROM ${MIGRATIONS_TABLE}`,
  );
  const appliedMap = new Map<string, string>();
  for (const r of appliedRows.rows) appliedMap.set(r.name, r.sha256);

  const applied: MigrationApplied[] = [];
  for (const file of files) {
    const prior = appliedMap.get(file.name);
    if (prior !== undefined) {
      if (prior !== file.sha256) {
        throw new DbError(
          `migration ${file.name} content changed since it was applied (recorded sha=${prior}, now=${file.sha256}). Refuse to re-apply; resolve manually.`,
        );
      }
      opts.logger?.({ kind: 'skip', name: file.name });
      continue;
    }
    await db.withTx(async (tx: QueryRunner) => {
      await tx.query(file.sql);
      await tx.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, sha256) VALUES ($1, $2)`, [
        file.name,
        file.sha256,
      ]);
    });
    opts.logger?.({ kind: 'apply', name: file.name });
    applied.push({ name: file.name, sha256: file.sha256, appliedAt: new Date() });
  }
  return applied;
}

async function ensureMigrationsTable(db: Database): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       name        TEXT         PRIMARY KEY,
       sha256      CHAR(64)     NOT NULL,
       applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
     )`,
  );
}

/** Load + sort + hash the .sql files in `dir`. */
export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const sql = entries.filter((n) => n.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const name of sql) {
    const text = await readFile(join(dir, name), 'utf8');
    const sha256 = createHash('sha256').update(text).digest('hex');
    out.push({ name, sha256, sql: text });
  }
  return out;
}

/** Test/diagnostic helper: list applied migrations from the runner table. */
export async function listAppliedMigrations(db: Database): Promise<MigrationApplied[]> {
  await ensureMigrationsTable(db);
  const r = await db.query<{
    name: string;
    sha256: string;
    applied_at: Date;
  }>(`SELECT name, sha256, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY applied_at ASC, name ASC`);
  return r.rows.map((row) => ({
    name: row.name,
    sha256: row.sha256,
    appliedAt: row.applied_at,
  }));
}

/** Public for tests + tooling. */
export const MIGRATIONS_TABLE_NAME = MIGRATIONS_TABLE;
