#!/usr/bin/env tsx
// Cron-triggered ingestion runner. Same image as the MCP server; Railway
// schedules this via a separate service with `pnpm ingest:scheduled` as
// its start command.
//
// Cadence (Phase 0 calibration 4):
//   - Feb / May / Aug / Nov → daily run (filing seasons; 13F-HR filings
//     land within the 45-day window after each calendar quarter-end).
//   - Other months → weekly run on Sundays (off-season touch-ups for
//     amendments / late filers).
//
// The cron schedule itself is set in Railway (configure two services, or
// a single service with two cron triggers). This script doesn't enforce
// the cadence — it just decides which quarter(s) to refresh based on the
// current date.

import 'dotenv/config';
import { createPgDatabase } from '../src/db/index.js';
import { EdgarClient } from '../src/sources/edgar/index.js';
import { CusipTickerMapRepo } from '../src/db/repos/cusipTickerMap.js';
import {
  CusipResolver,
  InMemoryCusipCache,
  LayeredCusipCache,
  OpenFigiClient,
} from '../src/sources/openfigi/index.js';
import { loadRoster } from '../src/resolution/index.js';
import { recentQuarterEnds, runIngestion } from '../src/ingestion/index.js';

const FILING_SEASON_MONTHS = new Set([1, 4, 7, 10]); // 0-indexed: Feb, May, Aug, Nov

function isFilingSeason(d: Date): boolean {
  return FILING_SEASON_MONTHS.has(d.getUTCMonth());
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  const edgarUserAgent = process.env['EDGAR_USER_AGENT'];
  if (!databaseUrl) {
    console.error('ingest-scheduled: DATABASE_URL is required');
    process.exit(1);
  }
  if (!edgarUserAgent) {
    console.error('ingest-scheduled: EDGAR_USER_AGENT is required');
    process.exit(1);
  }

  const today = new Date();
  const season = isFilingSeason(today);
  const runKind = season ? 'daily' : 'weekly';

  // During filing seasons we refresh the 2 most-recent quarters (active
  // + just-completed). Off-season we still refresh the most-recent quarter
  // in case of late filings or 13F-HR/A amendments.
  const periods = recentQuarterEnds(today, season ? 2 : 1);

  console.log(`ingest-scheduled: runKind=${runKind} periods=${periods.join(',')}`);

  const db = createPgDatabase({ connectionString: databaseUrl });
  const edgar = new EdgarClient({ userAgent: edgarUserAgent });
  const roster = await loadRoster();
  const memCache = new InMemoryCusipCache();
  const pgCache = new CusipTickerMapRepo(db);
  const layered = new LayeredCusipCache(memCache, pgCache);
  const figiKey = process.env['OPENFIGI_API_KEY'];
  const figi = figiKey ? new OpenFigiClient({ apiKey: figiKey }) : null;
  const cusipResolver = new CusipResolver(layered, figi);

  const rosterByCik = new Map(roster.map((r) => [r.cik, r]));

  const t0 = Date.now();
  try {
    const summary = await runIngestion(
      {
        filerCIKs: roster.map((r) => r.cik),
        targetPeriods: periods,
        runKind,
        rosterLookup: (cik) => {
          const entry = rosterByCik.get(cik);
          if (!entry || !entry.superinvestorTier) return null;
          return {
            displayName: entry.displayName,
            superinvestorTier: entry.superinvestorTier,
            primaryStrategy: entry.primaryStrategy ?? null,
            aliases: entry.aliases,
          };
        },
      },
      db,
      edgar,
      cusipResolver,
    );
    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`ingest-scheduled done in ${elapsedSec}s:`, {
      ingestionLogId: summary.ingestionLogId,
      filingsDiscovered: summary.filingsDiscovered,
      filingsParsed: summary.filingsParsed,
      filingsAmended: summary.filingsAmended,
      holdingsUpserted: summary.holdingsUpserted,
      parseErrors: summary.parseErrors,
    });
    if (summary.errorSamples.length > 0) {
      console.log(`  errorSamples (first ${summary.errorSamples.length}):`);
      for (const s of summary.errorSamples) {
        console.log(`    [${s.filerCIK}] ${s.accessionNumber}: ${s.error}`);
      }
    }
    // Non-zero exit when ANY filings parsed-with-errors so Railway records the
    // failure in its run history.
    if (summary.parseErrors > 0 && summary.filingsParsed === 0) {
      process.exit(2);
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('ingest-scheduled failed:', err);
  process.exit(1);
});
