// Top-level ingestion orchestrator.
//
// Walk a target set of (filerCIK, periodOfReport) pairs, fetch + parse +
// persist each filing, log overall progress to ingestion_log. Per-filing
// errors are collected and reported but do NOT abort the run — one bad
// filing doesn't take down the rest of the season's ingestion.

import { type Database, IngestionLogRepo } from '../db/index.js';
import type { EdgarClient } from '../sources/edgar/index.js';
import type { CusipResolver } from '../sources/openfigi/index.js';
import { discoverFilingsForFiler, type DiscoveredFiling } from './discover.js';
import { fetchAndParseFiling } from './parse.js';
import { persistFiling, type PersistFilingOptions } from './upsert.js';

export interface IngestionRunInput {
  filerCIKs: ReadonlyArray<string>;
  /** ISO YYYY-MM-DD quarter-end periods to ingest. */
  targetPeriods: ReadonlyArray<string>;
  /** Tags this run in ingestion_log. */
  runKind: 'backfill' | 'daily' | 'weekly' | 'manual' | 'amendment_recompute';
  /** Optional roster lookup for filer-row hydration. */
  rosterLookup?: PersistFilingOptions['rosterLookup'];
}

export interface IngestionRunSummary {
  ingestionLogId: number;
  filingsDiscovered: number;
  filingsParsed: number;
  filingsAmended: number;
  holdingsUpserted: number;
  parseErrors: number;
  errorSamples: Array<{
    filerCIK: string;
    accessionNumber: string;
    error: string;
  }>;
}

/**
 * Execute one ingestion run end-to-end. Per-filing errors are caught,
 * counted, and surfaced in the summary; the run completes regardless.
 */
export async function runIngestion(
  input: IngestionRunInput,
  db: Database,
  edgar: EdgarClient,
  cusipResolver: CusipResolver,
): Promise<IngestionRunSummary> {
  const logRepo = new IngestionLogRepo(db);
  const ingestionLogId = await logRepo.start(
    input.runKind,
    `filers=${input.filerCIKs.length} periods=${input.targetPeriods.length}`,
  );

  const periods = new Set(input.targetPeriods);
  const samples: Array<{
    filerCIK: string;
    accessionNumber: string;
    error: string;
  }> = [];
  let filingsDiscovered = 0;
  let filingsParsed = 0;
  let filingsAmended = 0;
  let holdingsUpserted = 0;
  let parseErrors = 0;

  try {
    for (const cik of input.filerCIKs) {
      let discovered: DiscoveredFiling[] = [];
      try {
        discovered = await discoverFilingsForFiler(edgar, cik, periods);
      } catch (err) {
        parseErrors += 1;
        samples.push({
          filerCIK: cik,
          accessionNumber: '',
          error: `discover: ${(err as Error).message}`,
        });
        continue;
      }
      filingsDiscovered += discovered.length;

      for (const d of discovered) {
        try {
          const fetched = await fetchAndParseFiling(
            edgar,
            d.filerCIK,
            d.accessionNumber,
            d.filingDate,
          );
          const persistOpts: PersistFilingOptions = {};
          if (input.rosterLookup) persistOpts.rosterLookup = input.rosterLookup;
          const out = await persistFiling(
            db,
            d.filerCIK,
            d.accessionNumber,
            d.filingDate,
            fetched,
            cusipResolver,
            persistOpts,
          );
          filingsParsed += 1;
          if (out.isAmendment) filingsAmended += 1;
          holdingsUpserted += out.holdingsUpserted;
        } catch (err) {
          parseErrors += 1;
          if (samples.length < 20) {
            samples.push({
              filerCIK: d.filerCIK,
              accessionNumber: d.accessionNumber,
              error: (err as Error).message,
            });
          }
        }
      }
    }
  } finally {
    await logRepo.finish(ingestionLogId, {
      filingsDiscovered,
      filingsParsed,
      filingsAmended,
      holdingsUpserted,
      parseErrors,
      parseErrorSamples: samples,
      notes: `runKind=${input.runKind}`,
    });
  }

  return {
    ingestionLogId,
    filingsDiscovered,
    filingsParsed,
    filingsAmended,
    holdingsUpserted,
    parseErrors,
    errorSamples: samples,
  };
}
