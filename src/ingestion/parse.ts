// Fetch + parse a single 13F filing end-to-end.

import {
  type EdgarClient,
  pickInfoTableFilename,
  accessionNoDashes,
  padCik,
  stripLeadingZeros,
} from '../sources/edgar/index.js';
import {
  parsePrimaryDoc,
  parseInfoTable,
  detectValueScale,
  normalizeValueToUSD,
  type ParsedPrimaryDoc,
  type AggregatedHolding,
  type ValueScale,
} from '../parser/index.js';

export class FilingFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilingFetchError';
  }
}

export interface FetchedFiling {
  primaryDoc: ParsedPrimaryDoc;
  holdings: AggregatedHolding[];
  /** USD-normalized cover-page tableValueTotal. */
  bookValueUSD: bigint;
  valueScale: ValueScale;
  /** URLs we hit (kept on the filings row for evidence trail). */
  primaryDocURL: string;
  infoTableURL: string;
  /** The filer-named InfoTable XML filename (calibration 2). */
  infoTableFilename: string;
}

/**
 * Fetch + parse the cover page and InfoTable for a (filer, accession).
 * Throws FilingFetchError if the filing has no parseable InfoTable.
 *
 * `filingDate` (caller-supplied from the submissions index) drives the
 * valueScale heuristic since pre-2023 cover pages don't tell us the scale.
 */
export async function fetchAndParseFiling(
  edgar: EdgarClient,
  filerCIK: string,
  accessionNumber: string,
  filingDate: string,
): Promise<FetchedFiling> {
  const padded = padCik(filerCIK);
  const cikPath = stripLeadingZeros(padded);
  const accPath = accessionNoDashes(accessionNumber);
  const archivesBase = `https://www.sec.gov/Archives/edgar/data/${cikPath}/${accPath}`;

  const primaryDocXml = await edgar.getFilingFile(filerCIK, accessionNumber, 'primary_doc.xml');
  const primaryDoc = parsePrimaryDoc(primaryDocXml);

  const index = await edgar.getFilingIndex(filerCIK, accessionNumber);
  const infoTableFilename = pickInfoTableFilename(index);
  if (!infoTableFilename) {
    throw new FilingFetchError(
      `no InfoTable XML in ${accessionNumber} (only primary_doc.xml found)`,
    );
  }

  const infoTableXml = await edgar.getFilingFile(filerCIK, accessionNumber, infoTableFilename);
  const parsedInfoTable = parseInfoTable(infoTableXml);

  const valueScale = detectValueScale(filingDate);
  const bookValueUSD = normalizeValueToUSD(primaryDoc.tableValueTotalRaw, valueScale);

  return {
    primaryDoc,
    holdings: parsedInfoTable.aggregatedHoldings,
    bookValueUSD,
    valueScale,
    primaryDocURL: `${archivesBase}/primary_doc.xml`,
    infoTableURL: `${archivesBase}/${infoTableFilename}`,
    infoTableFilename,
  };
}
