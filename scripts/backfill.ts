#!/usr/bin/env tsx
// Backfill — one-shot ingestion of the last N quarters for the curated
// superinvestor roster. Solves cold-start for Phase 3.11 + serves as a
// manual remediation tool for ingestion gaps.
//
// Usage:
//   pnpm backfill                    # default: 4 quarters × full roster
//   pnpm backfill -- --quarters=8    # custom quarter count
//   pnpm backfill -- --ciks=0001067983,0001649339   # subset
//
// Required env:
//   DATABASE_URL, EDGAR_USER_AGENT
// Optional env:
//   OPENFIGI_API_KEY (boosts CUSIP resolution rate; without it, unknown
//   CUSIPs map to null tickers — still ingestible).

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
import { runBackfill } from '../src/ingestion/index.js';

interface CliArgs {
  quarters: number;
  ciks: string[] | null;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let quarters = 4;
  let ciks: string[] | null = null;
  for (const a of argv) {
    if (a.startsWith('--quarters=')) {
      const v = parseInt(a.slice('--quarters='.length), 10);
      if (Number.isFinite(v) && v > 0) quarters = v;
    } else if (a.startsWith('--ciks=')) {
      ciks = a
        .slice('--ciks='.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }
  return { quarters, ciks };
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  const edgarUserAgent = process.env['EDGAR_USER_AGENT'];
  if (!databaseUrl) {
    console.error('backfill: DATABASE_URL is required');
    process.exit(1);
  }
  if (!edgarUserAgent) {
    console.error('backfill: EDGAR_USER_AGENT is required');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  console.log(
    `backfill: quarters=${args.quarters} ciks=${args.ciks ? args.ciks.length : 'roster'}`,
  );

  const db = createPgDatabase({ connectionString: databaseUrl });
  const edgar = new EdgarClient({ userAgent: edgarUserAgent });
  const roster = await loadRoster();
  const memCache = new InMemoryCusipCache();
  const pgCache = new CusipTickerMapRepo(db);
  const layered = new LayeredCusipCache(memCache, pgCache);
  const figiKey = process.env['OPENFIGI_API_KEY'];
  const figi = figiKey ? new OpenFigiClient({ apiKey: figiKey }) : null;
  const cusipResolver = new CusipResolver(layered, figi);

  const t0 = Date.now();
  try {
    const summary = await runBackfill(
      {
        roster,
        quarters: args.quarters,
        ...(args.ciks ? { filerCIKs: args.ciks } : {}),
      },
      db,
      edgar,
      cusipResolver,
    );
    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`backfill done in ${elapsedSec}s:`, {
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
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
