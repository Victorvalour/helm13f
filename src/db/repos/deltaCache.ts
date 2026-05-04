// `delta_cache` repository — pre-computed structuredContent envelopes
// keyed by axis + quarter pair + filter fingerprint (Phase 0 + Phase 2
// migration 002).

import type { QueryRunner } from '../pool.js';

export interface DeltaCacheEntry<T = unknown> {
  cacheKey: string;
  payload: T;
  inputsFingerprint: string;
  schemaVersion: number;
  computedAt: Date;
  expiresAt: Date | null;
}

export class DeltaCacheRepo {
  constructor(
    private readonly db: QueryRunner,
    private readonly schemaVersion = 1,
  ) {}

  async get<T>(cacheKey: string): Promise<DeltaCacheEntry<T> | null> {
    const r = await this.db.query<DbRow>(
      `SELECT cache_key, payload, inputs_fingerprint, schema_version,
              computed_at, expires_at
       FROM delta_cache
       WHERE cache_key = $1
         AND schema_version = $2
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [cacheKey, this.schemaVersion],
    );
    if (!r.rows[0]) return null;
    return rowToEntry<T>(r.rows[0]);
  }

  async set<T>(
    cacheKey: string,
    payload: T,
    opts: { inputsFingerprint: string; expiresAt?: Date | null } = {
      inputsFingerprint: '',
    },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO delta_cache (cache_key, payload, inputs_fingerprint, schema_version, expires_at)
       VALUES ($1, $2::jsonb, $3, $4, $5)
       ON CONFLICT (cache_key) DO UPDATE SET
         payload = EXCLUDED.payload,
         inputs_fingerprint = EXCLUDED.inputs_fingerprint,
         schema_version = EXCLUDED.schema_version,
         computed_at = NOW(),
         expires_at = EXCLUDED.expires_at`,
      [
        cacheKey,
        JSON.stringify(payload),
        opts.inputsFingerprint,
        this.schemaVersion,
        opts.expiresAt ?? null,
      ],
    );
  }

  async invalidatePrefix(prefix: string): Promise<number> {
    const r = await this.db.query(`DELETE FROM delta_cache WHERE cache_key LIKE $1`, [
      `${prefix}%`,
    ]);
    return r.rowCount ?? 0;
  }

  async invalidateAll(): Promise<void> {
    await this.db.query(`TRUNCATE delta_cache`);
  }
}

interface DbRow {
  cache_key: string;
  payload: unknown;
  inputs_fingerprint: string;
  schema_version: number;
  computed_at: Date;
  expires_at: Date | null;
}

function rowToEntry<T>(r: DbRow): DeltaCacheEntry<T> {
  return {
    cacheKey: r.cache_key,
    payload: r.payload as T,
    inputsFingerprint: r.inputs_fingerprint,
    schemaVersion: r.schema_version,
    computedAt: r.computed_at,
    expiresAt: r.expires_at,
  };
}
