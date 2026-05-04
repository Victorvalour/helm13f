// `ingestion_log` repository — observability for ingestion runs.

import type { QueryRunner } from '../pool.js';

export type IngestionRunKind = 'backfill' | 'daily' | 'weekly' | 'manual' | 'amendment_recompute';

export interface IngestionLogRow {
  id: number;
  runKind: IngestionRunKind;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  filingsDiscovered: number;
  filingsParsed: number;
  filingsAmended: number;
  holdingsUpserted: number;
  parseErrors: number;
  parseErrorSamples: unknown[];
  notes: string | null;
}

export class IngestionLogRepo {
  constructor(private readonly db: QueryRunner) {}

  async start(runKind: IngestionRunKind, notes?: string): Promise<number> {
    const r = await this.db.query<{ id: number }>(
      `INSERT INTO ingestion_log (run_kind, notes) VALUES ($1, $2) RETURNING id`,
      [runKind, notes ?? null],
    );
    return r.rows[0]!.id;
  }

  async finish(
    id: number,
    summary: {
      filingsDiscovered?: number;
      filingsParsed?: number;
      filingsAmended?: number;
      holdingsUpserted?: number;
      parseErrors?: number;
      parseErrorSamples?: unknown[];
      notes?: string;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE ingestion_log SET
         completed_at = NOW(),
         duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
         filings_discovered = COALESCE($2, filings_discovered),
         filings_parsed = COALESCE($3, filings_parsed),
         filings_amended = COALESCE($4, filings_amended),
         holdings_upserted = COALESCE($5, holdings_upserted),
         parse_errors = COALESCE($6, parse_errors),
         parse_error_samples = COALESCE($7::jsonb, parse_error_samples),
         notes = COALESCE($8, notes)
       WHERE id = $1`,
      [
        id,
        summary.filingsDiscovered ?? null,
        summary.filingsParsed ?? null,
        summary.filingsAmended ?? null,
        summary.holdingsUpserted ?? null,
        summary.parseErrors ?? null,
        summary.parseErrorSamples ? JSON.stringify(summary.parseErrorSamples) : null,
        summary.notes ?? null,
      ],
    );
  }

  async lastSuccessful(): Promise<IngestionLogRow | null> {
    const r = await this.db.query<DbRow>(
      `SELECT id, run_kind, started_at, completed_at, duration_ms,
              filings_discovered, filings_parsed, filings_amended,
              holdings_upserted, parse_errors, parse_error_samples, notes
       FROM ingestion_log
       WHERE completed_at IS NOT NULL
       ORDER BY completed_at DESC
       LIMIT 1`,
    );
    return r.rows[0] ? rowToLog(r.rows[0]) : null;
  }
}

interface DbRow {
  id: number;
  run_kind: IngestionRunKind;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
  filings_discovered: number;
  filings_parsed: number;
  filings_amended: number;
  holdings_upserted: number;
  parse_errors: number;
  parse_error_samples: unknown[];
  notes: string | null;
}

function rowToLog(r: DbRow): IngestionLogRow {
  return {
    id: r.id,
    runKind: r.run_kind,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    durationMs: r.duration_ms,
    filingsDiscovered: r.filings_discovered,
    filingsParsed: r.filings_parsed,
    filingsAmended: r.filings_amended,
    holdingsUpserted: r.holdings_upserted,
    parseErrors: r.parse_errors,
    parseErrorSamples: r.parse_error_samples,
    notes: r.notes,
  };
}
