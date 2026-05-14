// `holdings` table repository.
//
// Holdings rows are stored AFTER (cusip, putCall) aggregation per filing
// (Phase 0 calibration 3). The natural primary key is
// (accession_number, cusip, put_call), which the schema enforces.

import type { QueryRunner } from '../pool.js';

export interface HoldingRow {
  accessionNumber: string;
  filerCIK: string;
  periodOfReport: string;
  cusip: string;
  ticker: string | null;
  issuerName: string;
  titleOfClass: string;
  shares: bigint;
  valueUSD: bigint;
  pctOfBook: number;
  convictionTier: 'core' | 'meaningful' | 'starter' | 'scout';
  sshPrnamtType: 'SH' | 'PRN';
  putCall: 'Put' | 'Call' | null;
  investmentDiscretion: string | null;
  votingSole: bigint;
  votingShared: bigint;
  votingNone: bigint;
}

export interface HoldingUpsert {
  accessionNumber: string;
  filerCIK: string;
  periodOfReport: string;
  cusip: string;
  ticker: string | null;
  issuerName: string;
  titleOfClass: string;
  shares: bigint;
  valueUSD: bigint;
  pctOfBook: number;
  convictionTier: 'core' | 'meaningful' | 'starter' | 'scout';
  sshPrnamtType: 'SH' | 'PRN';
  putCall: 'Put' | 'Call' | null;
  investmentDiscretion?: string | null;
  votingSole?: bigint;
  votingShared?: bigint;
  votingNone?: bigint;
}

export class HoldingsRepo {
  constructor(private readonly db: QueryRunner) {}

  async listForFiling(accessionNumber: string): Promise<HoldingRow[]> {
    const r = await this.db.query<DbHoldingRow>(
      `${SELECT_HOLDINGS}
       WHERE accession_number = $1
       ORDER BY pct_of_book DESC, cusip ASC`,
      [accessionNumber],
    );
    return r.rows.map(rowToHolding);
  }

  /** All ACTIVE-filing holdings of a CIK in a given period (for the filer-axis Q4/E1). */
  async listActiveByFiler(filerCIK: string, periodOfReport: string): Promise<HoldingRow[]> {
    const r = await this.db.query<DbHoldingRow>(
      `${SELECT_HOLDINGS}
       WHERE filer_cik = $1 AND period_of_report = $2
         AND accession_number IN (
           SELECT accession_number FROM filings
           WHERE filer_cik = $1 AND period_of_report = $2
             AND superseded_by_accession IS NULL
         )
       ORDER BY pct_of_book DESC`,
      [filerCIK, periodOfReport],
    );
    return r.rows.map(rowToHolding);
  }

  /** All ACTIVE-filing holdings of a ticker in a given period (for the ticker-axis Q1-Q3/Q5/Q6/E2). */
  async listActiveByTicker(ticker: string, periodOfReport: string): Promise<HoldingRow[]> {
    const r = await this.db.query<DbHoldingRow>(
      `${SELECT_HOLDINGS}
       WHERE ticker = $1 AND period_of_report = $2
         AND accession_number IN (
           SELECT accession_number FROM filings
           WHERE period_of_report = $2 AND superseded_by_accession IS NULL
         )
       ORDER BY pct_of_book DESC`,
      [ticker, periodOfReport],
    );
    return r.rows.map(rowToHolding);
  }

  /**
   * Bulk-insert holdings for a filing. Caller must aggregate per
   * (cusip, putCall) first.
   *
   * Chunks the upsert into batches small enough that the bind message stays
   * under Postgres' 16-bit parameter-count field (max 65535 per statement).
   * At 17 columns/row, 500 rows = 8500 params — well under the limit.
   * Large quants (Renaissance, Citadel, Adage) file >700 row 13Fs that
   * blew the unchunked path with "bind message has N parameter formats
   * but 0 parameters" errors.
   */
  async upsertManyForFiling(rows: readonly HoldingUpsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    const CHUNK = 500;
    let total = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      total += await this.upsertChunk(rows.slice(i, i + CHUNK));
    }
    return total;
  }

  private async upsertChunk(rows: readonly HoldingUpsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    const placeholders: string[] = [];
    const params: unknown[] = [];
    const COLS = 17;
    for (const row of rows) {
      const base = params.length;
      const ph: string[] = [];
      for (let i = 1; i <= COLS; i++) ph.push(`$${base + i}`);
      placeholders.push(`(${ph.join(', ')})`);
      params.push(
        row.accessionNumber,
        row.filerCIK,
        row.periodOfReport,
        row.cusip,
        row.ticker ?? null,
        row.issuerName,
        row.titleOfClass,
        row.shares.toString(),
        row.valueUSD.toString(),
        row.pctOfBook.toFixed(6),
        row.convictionTier,
        row.sshPrnamtType,
        row.putCall ?? null,
        row.investmentDiscretion ?? null,
        (row.votingSole ?? 0n).toString(),
        (row.votingShared ?? 0n).toString(),
        (row.votingNone ?? 0n).toString(),
      );
    }
    const sql = `INSERT INTO holdings (
      accession_number, filer_cik, period_of_report, cusip, ticker,
      issuer_name, title_of_class, shares, value_usd, pct_of_book,
      conviction_tier, ssh_prnamt_type, put_call, investment_discretion,
      voting_sole, voting_shared, voting_none
    ) VALUES ${placeholders.join(', ')}
    ON CONFLICT (accession_number, cusip, put_call) DO UPDATE SET
      filer_cik = EXCLUDED.filer_cik,
      period_of_report = EXCLUDED.period_of_report,
      ticker = EXCLUDED.ticker,
      issuer_name = EXCLUDED.issuer_name,
      title_of_class = EXCLUDED.title_of_class,
      shares = EXCLUDED.shares,
      value_usd = EXCLUDED.value_usd,
      pct_of_book = EXCLUDED.pct_of_book,
      conviction_tier = EXCLUDED.conviction_tier,
      ssh_prnamt_type = EXCLUDED.ssh_prnamt_type,
      investment_discretion = EXCLUDED.investment_discretion,
      voting_sole = EXCLUDED.voting_sole,
      voting_shared = EXCLUDED.voting_shared,
      voting_none = EXCLUDED.voting_none`;
    const r = await this.db.query(sql, params);
    return r.rowCount ?? 0;
  }

  /** Backfill ticker for any holdings whose CUSIP just resolved. */
  async setTickerForCusip(cusip: string, ticker: string | null): Promise<number> {
    const r = await this.db.query(
      `UPDATE holdings SET ticker = $2 WHERE cusip = $1 AND (ticker IS DISTINCT FROM $2)`,
      [cusip, ticker],
    );
    return r.rowCount ?? 0;
  }
}

const SELECT_HOLDINGS = `
  SELECT accession_number, filer_cik, period_of_report, cusip, ticker,
         issuer_name, title_of_class, shares, value_usd, pct_of_book,
         conviction_tier, ssh_prnamt_type, put_call, investment_discretion,
         voting_sole, voting_shared, voting_none
  FROM holdings`;

interface DbHoldingRow {
  accession_number: string;
  filer_cik: string;
  period_of_report: Date | string;
  cusip: string;
  ticker: string | null;
  issuer_name: string;
  title_of_class: string;
  shares: string;
  value_usd: string;
  pct_of_book: string;
  conviction_tier: 'core' | 'meaningful' | 'starter' | 'scout';
  ssh_prnamt_type: 'SH' | 'PRN';
  put_call: 'Put' | 'Call' | null;
  investment_discretion: string | null;
  voting_sole: string;
  voting_shared: string;
  voting_none: string;
}

function rowToHolding(r: DbHoldingRow): HoldingRow {
  return {
    accessionNumber: r.accession_number,
    filerCIK: r.filer_cik,
    periodOfReport:
      typeof r.period_of_report === 'string'
        ? r.period_of_report.slice(0, 10)
        : r.period_of_report.toISOString().slice(0, 10),
    cusip: r.cusip,
    ticker: r.ticker,
    issuerName: r.issuer_name,
    titleOfClass: r.title_of_class,
    shares: BigInt(r.shares),
    valueUSD: BigInt(r.value_usd),
    pctOfBook: Number(r.pct_of_book),
    convictionTier: r.conviction_tier,
    sshPrnamtType: r.ssh_prnamt_type,
    putCall: r.put_call,
    investmentDiscretion: r.investment_discretion,
    votingSole: BigInt(r.voting_sole),
    votingShared: BigInt(r.voting_shared),
    votingNone: BigInt(r.voting_none),
  };
}
