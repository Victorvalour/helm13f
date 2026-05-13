// Response shapes returned by SEC EDGAR endpoints we use.
// Verified end-to-end against Berkshire CIK 1067983 / accession
// 0001193125-26-054580 in Phase 0.

/**
 * Response shape from data.sec.gov/submissions/CIK{paddedCIK}.json.
 *
 * The `filings.recent` block is the FIRST page of (currently 1000)
 * recent filings. Older history is referenced via `filings.files[].name`,
 * each pointing to a JSON file under data.sec.gov/submissions/{name}.
 */
export interface EdgarSubmissions {
  cik: string; // 10-digit padded
  name: string;
  tickers?: string[];
  exchanges?: string[];
  ein?: string | null;
  formerNames?: Array<{ name: string; from?: string; to?: string }>;
  filings: {
    recent: EdgarSubmissionsRecent;
    files?: Array<{
      name: string;
      filingCount?: number;
      filingFrom?: string;
      filingTo?: string;
    }>;
  };
}

/**
 * Parallel-array layout: arrays at every key are equal-length and
 * positionally aligned. accessionNumber[i] corresponds to form[i],
 * filingDate[i], reportDate[i], primaryDocument[i].
 *
 * Note: the submissions index uses `reportDate` for the period-of-report.
 * The cover-page XML inside the filing uses `periodOfReport` for the same
 * concept — we read `reportDate` here, then carry it forward as
 * `periodOfReport` internally to match the parsed shape.
 */
export interface EdgarSubmissionsRecent {
  accessionNumber: string[]; // "0001193125-26-054580"
  filingDate: string[]; // ISO YYYY-MM-DD
  reportDate?: string[]; // ISO YYYY-MM-DD; quarter-end for periodic forms.
  acceptanceDateTime?: string[];
  act?: string[];
  form: string[]; // e.g. "13F-HR", "13F-HR/A"
  fileNumber?: string[];
  filmNumber?: string[];
  items?: string[];
  size?: number[];
  isXBRL?: number[];
  isInlineXBRL?: number[];
  primaryDocument: string[];
  primaryDocDescription?: string[];
}

/**
 * Older-history page referenced by filings.files[].name.
 * Same parallel-array layout (no `files` field).
 */
export type EdgarSubmissionsPage = EdgarSubmissionsRecent;

/**
 * Response shape from www.sec.gov/Archives/edgar/data/{CIK}/{accNoDashes}/index.json.
 * Used to discover the filer-named INFOTABLE XML (calibration: never
 * string-construct the filename).
 */
export interface EdgarFilingIndex {
  directory: {
    name: string;
    'parent-dir': string;
    item: Array<{
      name: string;
      type: string;
      'last-modified': string;
      size: string;
    }>;
  };
}

/**
 * Response shape from www.sec.gov/files/company_tickers.json.
 * Indexed by stringified ordinal (the file is a numbered map).
 */
export type EdgarCompanyTickers = Record<
  string,
  {
    cik_str: number;
    ticker: string;
    title: string;
  }
>;

/**
 * Response shape from efts.sec.gov/LATEST/search-index.
 * Used during universe expansion (Phase 3.8) to discover all 13F-HR filers.
 */
export interface EdgarFullTextSearchResult {
  hits: {
    total: { value: number; relation?: string };
    hits: Array<{
      _id: string;
      _source: {
        ciks?: string[];
        display_names?: string[];
        adsh?: string;
        form?: string;
        file_date?: string;
        [k: string]: unknown;
      };
    }>;
  };
}
