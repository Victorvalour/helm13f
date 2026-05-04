// `filings` table repository.

import type { QueryRunner } from '../pool.js';

export interface FilingRow {
  accessionNumber: string;
  filerCIK: string;
  form: '13F-HR' | '13F-HR/A';
  isAmendment: boolean;
  supersededByAccession: string | null;
  periodOfReport: string; // ISO YYYY-MM-DD
  filingDate: string; // ISO YYYY-MM-DD
  bookValueUSD: bigint;
  valueScale: 'USD' | 'USD_THOUSANDS';
  tableEntryTotal: number;
  primaryDocURL: string;
  infoTableURL: string;
  infoTableFilename: string;
  rawXmlSha256: string | null;
  ingestedAt: Date;
}

export interface FilingUpsert {
  accessionNumber: string;
  filerCIK: string;
  form: '13F-HR' | '13F-HR/A';
  isAmendment: boolean;
  periodOfReport: string;
  filingDate: string;
  bookValueUSD: bigint;
  valueScale: 'USD' | 'USD_THOUSANDS';
  tableEntryTotal: number;
  primaryDocURL: string;
  infoTableURL: string;
  infoTableFilename: string;
  rawXmlSha256?: string | null;
}

export class FilingsRepo {
  constructor(private readonly db: QueryRunner) {}

  async getByAccession(accession: string): Promise<FilingRow | null> {
    const r = await this.db.query<DbFilingRow>(
      `SELECT accession_number, filer_cik, form, is_amendment,
              superseded_by_accession, period_of_report, filing_date,
              book_value_usd, value_scale, table_entry_total,
              primary_doc_url, info_table_url, info_table_filename,
              raw_xml_sha256, ingested_at
       FROM filings WHERE accession_number = $1`,
      [accession],
    );
    return r.rows[0] ? rowToFiling(r.rows[0]) : null;
  }

  async listByFilerAndPeriod(filerCIK: string, periodOfReport: string): Promise<FilingRow[]> {
    const r = await this.db.query<DbFilingRow>(
      `SELECT accession_number, filer_cik, form, is_amendment,
              superseded_by_accession, period_of_report, filing_date,
              book_value_usd, value_scale, table_entry_total,
              primary_doc_url, info_table_url, info_table_filename,
              raw_xml_sha256, ingested_at
       FROM filings
       WHERE filer_cik = $1 AND period_of_report = $2
       ORDER BY filing_date ASC`,
      [filerCIK, periodOfReport],
    );
    return r.rows.map(rowToFiling);
  }

  /**
   * Get the active (non-superseded) filing for a filer's quarter, if any.
   * Used by every Query/Execute path that needs "the filing currently in
   * effect" for a (filer, period) pair after amendment handling.
   */
  async getActive(filerCIK: string, periodOfReport: string): Promise<FilingRow | null> {
    const r = await this.db.query<DbFilingRow>(
      `SELECT accession_number, filer_cik, form, is_amendment,
              superseded_by_accession, period_of_report, filing_date,
              book_value_usd, value_scale, table_entry_total,
              primary_doc_url, info_table_url, info_table_filename,
              raw_xml_sha256, ingested_at
       FROM filings
       WHERE filer_cik = $1 AND period_of_report = $2
         AND superseded_by_accession IS NULL
       ORDER BY filing_date DESC
       LIMIT 1`,
      [filerCIK, periodOfReport],
    );
    return r.rows[0] ? rowToFiling(r.rows[0]) : null;
  }

  async upsert(input: FilingUpsert): Promise<FilingRow> {
    const r = await this.db.query<DbFilingRow>(
      `INSERT INTO filings (
         accession_number, filer_cik, form, is_amendment,
         period_of_report, filing_date, book_value_usd, value_scale,
         table_entry_total, primary_doc_url, info_table_url,
         info_table_filename, raw_xml_sha256
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       )
       ON CONFLICT (accession_number) DO UPDATE SET
         filer_cik         = EXCLUDED.filer_cik,
         form              = EXCLUDED.form,
         is_amendment      = EXCLUDED.is_amendment,
         period_of_report  = EXCLUDED.period_of_report,
         filing_date       = EXCLUDED.filing_date,
         book_value_usd    = EXCLUDED.book_value_usd,
         value_scale       = EXCLUDED.value_scale,
         table_entry_total = EXCLUDED.table_entry_total,
         primary_doc_url   = EXCLUDED.primary_doc_url,
         info_table_url    = EXCLUDED.info_table_url,
         info_table_filename = EXCLUDED.info_table_filename,
         raw_xml_sha256    = COALESCE(EXCLUDED.raw_xml_sha256, filings.raw_xml_sha256),
         ingested_at       = NOW()
       RETURNING accession_number, filer_cik, form, is_amendment,
                 superseded_by_accession, period_of_report, filing_date,
                 book_value_usd, value_scale, table_entry_total,
                 primary_doc_url, info_table_url, info_table_filename,
                 raw_xml_sha256, ingested_at`,
      [
        input.accessionNumber,
        input.filerCIK,
        input.form,
        input.isAmendment,
        input.periodOfReport,
        input.filingDate,
        input.bookValueUSD.toString(),
        input.valueScale,
        input.tableEntryTotal,
        input.primaryDocURL,
        input.infoTableURL,
        input.infoTableFilename,
        input.rawXmlSha256 ?? null,
      ],
    );
    return rowToFiling(r.rows[0]!);
  }

  /**
   * Mark a prior accession as superseded by `byAccession`. Used during
   * amendment handling: when a 13F-HR/A arrives for a (filer, period),
   * we point the prior 13F-HR's superseded_by_accession at it.
   */
  async markSuperseded(priorAccession: string, byAccession: string): Promise<void> {
    await this.db.query(
      `UPDATE filings SET superseded_by_accession = $2 WHERE accession_number = $1`,
      [priorAccession, byAccession],
    );
  }
}

interface DbFilingRow {
  accession_number: string;
  filer_cik: string;
  form: '13F-HR' | '13F-HR/A';
  is_amendment: boolean;
  superseded_by_accession: string | null;
  period_of_report: Date | string;
  filing_date: Date | string;
  book_value_usd: string;
  value_scale: 'USD' | 'USD_THOUSANDS';
  table_entry_total: number;
  primary_doc_url: string;
  info_table_url: string;
  info_table_filename: string;
  raw_xml_sha256: string | null;
  ingested_at: Date;
}

function rowToFiling(r: DbFilingRow): FilingRow {
  return {
    accessionNumber: r.accession_number,
    filerCIK: r.filer_cik,
    form: r.form,
    isAmendment: r.is_amendment,
    supersededByAccession: r.superseded_by_accession,
    periodOfReport: toIsoDate(r.period_of_report),
    filingDate: toIsoDate(r.filing_date),
    bookValueUSD: BigInt(r.book_value_usd),
    valueScale: r.value_scale,
    tableEntryTotal: r.table_entry_total,
    primaryDocURL: r.primary_doc_url,
    infoTableURL: r.info_table_url,
    infoTableFilename: r.info_table_filename,
    rawXmlSha256: r.raw_xml_sha256,
    ingestedAt: r.ingested_at,
  };
}

function toIsoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}
