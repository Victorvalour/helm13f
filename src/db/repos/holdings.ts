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

export interface ConcentrationRow {
  filerCIK: string;
  filerName: string;
  filerDisplayName: string | null;
  superinvestorTier: 'legendary' | 'well-known' | 'notable' | null;
  periodOfReport: string;
  accessionNumber: string;
  bookValueUSD: bigint;
  holdingCount: number;
  topPositionPctOfBook: number;
  topPosition: {
    ticker: string | null;
    issuerName: string;
    cusip: string;
    shares: bigint;
    valueUSD: bigint;
  };
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

  /**
   * Per-filer concentration snapshot for a given quarter, ranked by
   * top-position pctOfBook desc, then holding count asc. Used by Q7.
   *
   * Filter `superinvestorTier`: when set, restrict to filers in that tier.
   * When null, all filers (no roster filter).
   *
   * Returns at most `limit` rows. Each row carries the filer's latest
   * non-superseded filing for the requested period, the top holding's
   * cusip/ticker/issuer/shares/value, holding count, and book value.
   */
  async listConcentrationByQuarter(input: {
    periodOfReport: string;
    superinvestorTier: 'legendary' | 'well-known' | 'notable' | null;
    limit: number;
  }): Promise<ConcentrationRow[]> {
    const params: unknown[] = [input.periodOfReport, input.limit];
    let tierClause = '';
    if (input.superinvestorTier !== null) {
      params.push(input.superinvestorTier);
      tierClause = `AND fr.superinvestor_tier = $${params.length}`;
    }
    const sql = `
      WITH active_filings AS (
        SELECT fi.filer_cik, fi.accession_number, fi.book_value_usd, fi.period_of_report
        FROM filings fi
        JOIN filers fr ON fr.filer_cik = fi.filer_cik
        WHERE fi.period_of_report = $1
          AND fi.superseded_by_accession IS NULL
          AND fr.is_superinvestor = true
          ${tierClause}
      ),
      per_filer AS (
        SELECT
          af.filer_cik,
          af.accession_number,
          af.book_value_usd,
          af.period_of_report,
          COUNT(h.cusip) AS holding_count,
          MAX(h.pct_of_book) AS top_pct_of_book
        FROM active_filings af
        JOIN holdings h ON h.accession_number = af.accession_number
        GROUP BY af.filer_cik, af.accession_number, af.book_value_usd, af.period_of_report
      ),
      top_holding AS (
        SELECT DISTINCT ON (h.accession_number)
          h.accession_number,
          h.cusip,
          h.ticker,
          h.issuer_name,
          h.shares,
          h.value_usd,
          h.pct_of_book
        FROM holdings h
        JOIN per_filer pf ON pf.accession_number = h.accession_number
        ORDER BY h.accession_number, h.pct_of_book DESC
      )
      SELECT
        pf.filer_cik,
        pf.accession_number,
        pf.book_value_usd,
        pf.period_of_report,
        pf.holding_count,
        pf.top_pct_of_book,
        fr.filer_name,
        fr.display_name,
        fr.superinvestor_tier,
        th.cusip       AS top_cusip,
        th.ticker      AS top_ticker,
        th.issuer_name AS top_issuer_name,
        th.shares      AS top_shares,
        th.value_usd   AS top_value_usd
      FROM per_filer pf
      JOIN filers fr ON fr.filer_cik = pf.filer_cik
      JOIN top_holding th ON th.accession_number = pf.accession_number
      ORDER BY pf.top_pct_of_book DESC, pf.holding_count ASC
      LIMIT $2
    `;
    const r = await this.db.query<DbConcentrationRow>(sql, params);
    return r.rows.map((row) => ({
      filerCIK: row.filer_cik,
      filerName: row.filer_name,
      filerDisplayName: row.display_name,
      superinvestorTier: row.superinvestor_tier,
      periodOfReport:
        typeof row.period_of_report === 'string'
          ? row.period_of_report
          : row.period_of_report.toISOString().slice(0, 10),
      accessionNumber: row.accession_number,
      bookValueUSD: BigInt(row.book_value_usd),
      holdingCount: Number(row.holding_count),
      topPositionPctOfBook: Number(row.top_pct_of_book),
      topPosition: {
        ticker: row.top_ticker,
        issuerName: row.top_issuer_name,
        cusip: row.top_cusip,
        shares: BigInt(row.top_shares),
        valueUSD: BigInt(row.top_value_usd),
      },
    }));
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

interface DbConcentrationRow {
  filer_cik: string;
  filer_name: string;
  display_name: string | null;
  superinvestor_tier: 'legendary' | 'well-known' | 'notable' | null;
  period_of_report: Date | string;
  accession_number: string;
  book_value_usd: string;
  holding_count: string | number;
  top_pct_of_book: string | number;
  top_cusip: string;
  top_ticker: string | null;
  top_issuer_name: string;
  top_shares: string;
  top_value_usd: string;
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
