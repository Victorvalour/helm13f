// 13F-HR primary_doc.xml + INFOTABLE XML parsed shapes.
//
// Field names mirror the SEC schema (camelCase) where possible; the XML
// itself uses mixed namespacing which the parser strips.

/** Cover page parsed from primary_doc.xml. */
export interface ParsedPrimaryDoc {
  /** "13F-HR" or "13F-HR/A". */
  submissionType: '13F-HR' | '13F-HR/A';
  /** True iff submissionType ends with "/A" (matches coverPage.isAmendment). */
  isAmendment: boolean;
  /** Filer's CIK (10-digit zero-padded). */
  filerCIK: string;
  /** Period of report in ISO YYYY-MM-DD (always quarter-end). */
  periodOfReport: string;
  /** Filer's reported name from coverPage.filingManager.name. */
  filerName: string;
  /** Cover-page report type, e.g. "13F HOLDINGS REPORT". */
  reportType: string;
  /** Signature date in ISO YYYY-MM-DD (when present). */
  signatureDate: string | null;
  /** Total holdings rows in the InfoTable (cover-page count). */
  tableEntryTotal: number;
  /**
   * Cover-page tableValueTotal as written in the XML (NOT normalized
   * to USD). Apply `normalizeValueToUSD(raw, valueScale)` to convert.
   */
  tableValueTotalRaw: number;
  /** Other included managers (sub-managers Berkshire reports for, etc.). */
  otherIncludedManagers: ParsedOtherManager[];
  /** True iff cover page has isConfidentialOmitted=true. Default false. */
  isConfidentialOmitted: boolean;
}

export interface ParsedOtherManager {
  sequenceNumber: number;
  form13FFileNumber: string | null;
  name: string;
}

/**
 * One raw <infoTable> row, exactly as written in the XML, with sshPrnamt
 * and value left as numeric strings to preserve precision before
 * aggregation/normalization.
 */
export interface RawInfoTableRow {
  nameOfIssuer: string;
  titleOfClass: string;
  cusip: string;
  /** Raw <value> as numeric string. NOT normalized to USD. */
  valueRaw: string;
  /** Raw <sshPrnamt> as numeric string. */
  sharesRaw: string;
  sshPrnamtType: 'SH' | 'PRN';
  /** Null when the row is the underlying equity; "Put"/"Call" for options. */
  putCall: 'Put' | 'Call' | null;
  investmentDiscretion: string | null;
  /** Comma-separated list as written in the XML, or null when absent. */
  otherManager: string | null;
  votingAuthority: { sole: bigint; shared: bigint; none: bigint };
}

/**
 * One logical holding after (cusip, putCall) aggregation per filing
 * (Phase 0 calibration 3). Represents a single line in the `holdings`
 * Postgres table.
 */
export interface AggregatedHolding {
  cusip: string;
  putCall: 'Put' | 'Call' | null;
  /** First-seen issuer name across the aggregated rows. */
  nameOfIssuer: string;
  /** First-seen titleOfClass across the aggregated rows. */
  titleOfClass: string;
  /** Sum of sshPrnamt across the aggregated rows. */
  shares: bigint;
  /** Sum of <value> raw across the aggregated rows. NOT yet normalized. */
  valueRaw: bigint;
  /**
   * sshPrnamtType MUST be uniform across rows of the same (cusip, putCall);
   * otherwise the parser throws.
   */
  sshPrnamtType: 'SH' | 'PRN';
  /** First non-null investmentDiscretion. */
  investmentDiscretion: string | null;
  /** Sum of votingAuthority across rows. */
  votingAuthority: { sole: bigint; shared: bigint; none: bigint };
  /** Count of raw rows that aggregated into this entry (≥ 1). */
  sourceRowCount: number;
}

export interface ParsedInfoTable {
  /** All raw rows as parsed (no aggregation). */
  rawRows: RawInfoTableRow[];
  /** Aggregated holdings keyed by (cusip, putCall). */
  aggregatedHoldings: AggregatedHolding[];
}

/**
 * Reflects whether the source filing reports values in dollars (post-2023-Q3)
 * or thousands of dollars (pre-2023-Q3). Set by the caller based on filingDate.
 */
export type ValueScale = 'USD' | 'USD_THOUSANDS';
