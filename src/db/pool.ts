// Thin wrapper around node-postgres' Pool with the conventions Helm13F
// uses everywhere: parameterized queries only, transactions via withTx,
// and a typed Database interface so repositories can be tested against
// either a real Pool or an in-memory stub.

import pg from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

const { Pool } = pg;

export interface QueryRunner {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<R>>;
}

export interface Database extends QueryRunner {
  /**
   * Run `fn` inside a transaction. The fn receives a QueryRunner pinned to
   * a single client. Commits on success, rolls back on throw.
   */
  withTx<T>(fn: (client: QueryRunner) => Promise<T>): Promise<T>;
  /** Closes the underlying pool. Idempotent. */
  close(): Promise<void>;
}

export class DbError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DbError';
    this.cause = cause;
  }
}

export interface PgDatabaseOptions {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  /** Enables SSL for managed Postgres (Neon, Railway, etc.). Default true unless on localhost. */
  ssl?: boolean;
}

export function createPgDatabase(opts: PgDatabaseOptions): Database {
  const isLocal =
    /localhost|127\.0\.0\.1/.test(opts.connectionString) &&
    !/sslmode=require/.test(opts.connectionString);
  const ssl = (opts.ssl ?? !isLocal) ? { rejectUnauthorized: false } : false;
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 10_000,
    ssl,
  });

  return {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: ReadonlyArray<unknown>,
    ) {
      try {
        return await pool.query<R>(text, values as unknown[]);
      } catch (err) {
        throw new DbError(
          `query failed: ${(err as Error).message}\n  SQL: ${text.slice(0, 200)}`,
          err,
        );
      }
    },
    async withTx<T>(fn: (client: QueryRunner) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const runner: QueryRunner = {
          query: async <R extends QueryResultRow = QueryResultRow>(
            text: string,
            values?: ReadonlyArray<unknown>,
          ) => {
            try {
              return await client.query<R>(text, values as unknown[]);
            } catch (err) {
              throw new DbError(
                `tx query failed: ${(err as Error).message}\n  SQL: ${text.slice(0, 200)}`,
                err,
              );
            }
          },
        };
        const out = await fn(runner);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore
        }
        throw err instanceof DbError
          ? err
          : new DbError(`transaction failed: ${(err as Error).message}`, err);
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
