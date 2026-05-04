// `cusip_ticker_map` repository + the Postgres-backed CusipCache adapter
// that plugs into the OpenFIGI module's LayeredCusipCache (step 4).

import type { QueryRunner } from '../pool.js';
import type { CusipCache, CusipRecord } from '../../sources/openfigi/cache.js';

export class CusipTickerMapRepo implements CusipCache {
  constructor(private readonly db: QueryRunner) {}

  async get(cusip: string): Promise<CusipRecord | null> {
    const r = await this.db.query<DbRow>(
      `SELECT cusip, ticker, issuer_name, source, last_verified_at
       FROM cusip_ticker_map WHERE cusip = $1`,
      [cusip],
    );
    return r.rows[0] ? rowToRecord(r.rows[0]) : null;
  }

  async getMany(cusips: readonly string[]): Promise<Map<string, CusipRecord | null>> {
    const out = new Map<string, CusipRecord | null>();
    for (const c of cusips) out.set(c, null);
    if (cusips.length === 0) return out;
    const r = await this.db.query<DbRow>(
      `SELECT cusip, ticker, issuer_name, source, last_verified_at
       FROM cusip_ticker_map WHERE cusip = ANY($1::text[])`,
      [cusips],
    );
    for (const row of r.rows) out.set(row.cusip, rowToRecord(row));
    return out;
  }

  async set(record: CusipRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO cusip_ticker_map (cusip, ticker, issuer_name, source, last_verified_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cusip) DO UPDATE SET
         ticker = EXCLUDED.ticker,
         issuer_name = COALESCE(EXCLUDED.issuer_name, cusip_ticker_map.issuer_name),
         source = EXCLUDED.source,
         last_verified_at = EXCLUDED.last_verified_at`,
      [record.cusip, record.ticker, record.issuerName, record.source, record.lastVerifiedAt],
    );
  }

  async setMany(records: readonly CusipRecord[]): Promise<void> {
    if (records.length === 0) return;
    // Build one insert with multi-row VALUES.
    const rows: string[] = [];
    const params: unknown[] = [];
    for (const r of records) {
      const b = params.length;
      rows.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`);
      params.push(r.cusip, r.ticker, r.issuerName, r.source, r.lastVerifiedAt);
    }
    const sql = `INSERT INTO cusip_ticker_map (cusip, ticker, issuer_name, source, last_verified_at)
                 VALUES ${rows.join(', ')}
                 ON CONFLICT (cusip) DO UPDATE SET
                   ticker = EXCLUDED.ticker,
                   issuer_name = COALESCE(EXCLUDED.issuer_name, cusip_ticker_map.issuer_name),
                   source = EXCLUDED.source,
                   last_verified_at = EXCLUDED.last_verified_at`;
    await this.db.query(sql, params);
  }
}

interface DbRow {
  cusip: string;
  ticker: string | null;
  issuer_name: string | null;
  source: 'company_tickers' | 'openfigi' | 'manual_override';
  last_verified_at: Date;
}

function rowToRecord(r: DbRow): CusipRecord {
  return {
    cusip: r.cusip,
    ticker: r.ticker,
    issuerName: r.issuer_name,
    source: r.source,
    lastVerifiedAt: r.last_verified_at,
  };
}
