// E2E: real Postgres + mocked EDGAR. Run ingestion over the three real
// 13F fixtures (Berkshire, Scion, Pershing) and verify rows land in
// filings/holdings/filers as expected.
//
// Requires `pnpm db:up` first. Skipped automatically when DATABASE_URL
// is unreachable.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { runIngestion } from '../../src/ingestion/index.js';
import { FilingsRepo, HoldingsRepo, FilersRepo, IngestionLogRepo } from '../../src/db/index.js';
import { connectAndMigrate, type E2EHarness } from './setup.js';
import { makeFixtureEdgar } from './mock-edgar.js';
import { makeStubResolver } from './stub-resolver.js';

let harness: E2EHarness | null;

beforeAll(async () => {
  harness = await connectAndMigrate();
});

afterAll(async () => {
  if (harness) await harness.close();
});

beforeEach(async () => {
  if (harness) await harness.reset();
});

describe.skipIf(!process.env['DATABASE_URL'])('e2e — ingestion (real Postgres)', () => {
  it('ingests Berkshire + Pershing for 2025-12-31 → 2 filings + holdings rows', async () => {
    if (!harness) return;
    const summary = await runIngestion(
      {
        filerCIKs: ['0001067983', '0001336528'],
        targetPeriods: ['2025-12-31'],
        runKind: 'manual',
      },
      harness.db,
      makeFixtureEdgar(),
      makeStubResolver(),
    );

    expect(summary.filingsDiscovered).toBe(2);
    expect(summary.filingsParsed).toBe(2);
    expect(summary.parseErrors).toBe(0);

    const filingsRepo = new FilingsRepo(harness.db);
    const holdingsRepo = new HoldingsRepo(harness.db);

    const berk = await filingsRepo.getByAccession('0001193125-26-054580');
    expect(berk).not.toBeNull();
    expect(berk!.bookValueUSD).toBe(274_160_086_701n);
    expect(berk!.periodOfReport).toBe('2025-12-31');
    expect(berk!.tableEntryTotal).toBe(110);
    expect(berk!.valueScale).toBe('USD');

    const pershing = await filingsRepo.getByAccession('0001172661-26-001091');
    expect(pershing).not.toBeNull();
    expect(pershing!.bookValueUSD).toBe(15_526_737_802n);

    // Berkshire holdings: 110 raw rows aggregated to 42 by (cusip, putCall).
    const berkHoldings = await holdingsRepo.listForFiling('0001193125-26-054580');
    expect(berkHoldings).toHaveLength(42);

    const ally = berkHoldings.find((h) => h.cusip === '02005N100');
    expect(ally).toBeDefined();
    expect(ally!.shares).toBe(29_000_000n);
    expect(ally!.valueUSD).toBe(1_313_410_001n);
    expect(ally!.issuerName).toBe('ALLY FINL INC');
  });

  it('stamps superinvestor metadata on the filers row from roster lookup', async () => {
    if (!harness) return;
    await runIngestion(
      {
        filerCIKs: ['0001067983'],
        targetPeriods: ['2025-12-31'],
        runKind: 'manual',
        rosterLookup: (cik) =>
          cik === '0001067983'
            ? {
                displayName: 'Berkshire Hathaway',
                superinvestorTier: 'legendary',
                primaryStrategy: 'value',
                aliases: ['Buffett'],
              }
            : null,
      },
      harness.db,
      makeFixtureEdgar(),
      makeStubResolver(),
    );

    const filer = await new FilersRepo(harness.db).getByCik('0001067983');
    expect(filer).not.toBeNull();
    expect(filer!.isSuperinvestor).toBe(true);
    expect(filer!.superinvestorTier).toBe('legendary');
    expect(filer!.displayName).toBe('Berkshire Hathaway');
    expect(filer!.aliases).toContain('Buffett');
  });

  it('records the run in ingestion_log with accurate counts', async () => {
    if (!harness) return;
    await runIngestion(
      {
        filerCIKs: ['0001067983', '0001649339', '0001336528'],
        targetPeriods: ['2025-12-31', '2025-09-30'],
        runKind: 'backfill',
      },
      harness.db,
      makeFixtureEdgar(),
      makeStubResolver(),
    );

    const last = await new IngestionLogRepo(harness.db).lastSuccessful();
    expect(last).not.toBeNull();
    expect(last!.runKind).toBe('backfill');
    // Each fixture matches exactly one of the targetPeriods so we get
    // 3 discovered + 3 parsed total (Berkshire @ 12-31, Scion @ 09-30,
    // Pershing @ 12-31).
    expect(last!.filingsDiscovered).toBe(3);
    expect(last!.filingsParsed).toBe(3);
    expect(last!.parseErrors).toBe(0);
    expect(last!.completedAt).not.toBeNull();
    expect(last!.durationMs).not.toBeNull();
  });
});
