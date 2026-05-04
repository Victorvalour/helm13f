// Migrations runner unit tests using a stub Database.
//
// We do not require a real Postgres for these tests; the runner's logic
// (file discovery, sha256 fingerprint, idempotent re-application) is
// exercised against an in-memory fake.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate, MIGRATIONS_TABLE_NAME } from '../../src/db/index.js';
import type { Database, QueryRunner } from '../../src/db/index.js';
import { DbError } from '../../src/db/pool.js';

class FakeDb implements Database {
  public readonly migrationsApplied: Array<{ name: string; sha256: string }> = [];
  public readonly executedSql: string[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async query<R extends { [k: string]: unknown } = { [k: string]: unknown }>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.executedSql.push(text);
    if (text.includes(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE_NAME}`)) {
      return makeQueryResult([]);
    }
    if (text.startsWith(`SELECT name, sha256 FROM ${MIGRATIONS_TABLE_NAME}`)) {
      return makeQueryResult(this.migrationsApplied as unknown as R[]);
    }
    if (text.startsWith(`INSERT INTO ${MIGRATIONS_TABLE_NAME}`)) {
      const [name, sha256] = values as [string, string];
      this.migrationsApplied.push({ name, sha256 });
      return makeQueryResult([]);
    }
    return makeQueryResult([]);
  }

  withTx<T>(fn: (client: QueryRunner) => Promise<T>): Promise<T> {
    return fn(this);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function makeQueryResult<R>(rows: R[]) {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [] as never[],
  };
}

function mkdir(): string {
  return mkdtempSync(join(tmpdir(), 'helm13f-migrate-'));
}

describe('migrate', () => {
  it('applies all .sql files in lexical order on a fresh DB', async () => {
    const dir = mkdir();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INT);');
    writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (id INT);');
    const db = new FakeDb();
    const events: Array<{ kind: string; name?: string }> = [];
    const out = await migrate(db, {
      dir,
      logger: (e) => events.push(e),
    });
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.name)).toEqual(['001_a.sql', '002_b.sql']);
    expect(events.map((e) => e.kind)).toEqual(['init', 'apply', 'apply']);
    // The bookkeeping insert ran for each migration.
    expect(db.migrationsApplied).toHaveLength(2);
  });

  it('skips already-applied migrations and applies only new ones', async () => {
    const dir = mkdir();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INT);');
    writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (id INT);');
    const db = new FakeDb();
    await migrate(db, { dir });

    // Add a third migration; expect only that one is applied.
    writeFileSync(join(dir, '003_c.sql'), 'CREATE TABLE c (id INT);');
    const events: Array<{ kind: string; name?: string }> = [];
    const out = await migrate(db, {
      dir,
      logger: (e) => events.push(e),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('003_c.sql');
    expect(events.filter((e) => e.kind === 'skip').map((e) => e.name)).toEqual([
      '001_a.sql',
      '002_b.sql',
    ]);
  });

  it('refuses to re-apply a migration whose contents changed', async () => {
    const dir = mkdir();
    const path = join(dir, '001_a.sql');
    writeFileSync(path, 'CREATE TABLE a (id INT);');
    const db = new FakeDb();
    await migrate(db, { dir });

    writeFileSync(path, 'CREATE TABLE a (id BIGINT);');
    await expect(migrate(db, { dir })).rejects.toBeInstanceOf(DbError);
  });

  it('ignores non-sql files in the migrations directory', async () => {
    const dir = mkdir();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INT);');
    writeFileSync(join(dir, 'README.md'), '# notes');
    const db = new FakeDb();
    const out = await migrate(db, { dir });
    expect(out).toHaveLength(1);
  });
});

describe('migrate — Helm13F production migrations', () => {
  it('discovers both 001_filers_filings_holdings.sql and 002_lookup_and_cache.sql', async () => {
    const dir = join(process.cwd(), 'migrations');
    const db = new FakeDb();
    const out = await migrate(db, { dir });
    expect(out.map((m) => m.name)).toEqual([
      '001_filers_filings_holdings.sql',
      '002_lookup_and_cache.sql',
    ]);
    // Each migration must have a non-empty sha256.
    for (const m of out) {
      expect(m.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
