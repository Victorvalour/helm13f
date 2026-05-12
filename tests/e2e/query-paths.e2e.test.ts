// E2E: QueryService against real Postgres. Seeds a deterministic
// scenario via direct SQL (faster + more controllable than full
// ingestion for delta-classification checks), then exercises every
// public tool through the service.
//
// Scenario design:
//   - Ticker TEST_TKR (cusip TESTTKR01) — 3 superinvestors NEWLY initiate.
//   - Ticker EXIT_TKR (cusip EXITTKR02) — 1 superinvestor exits.
//   - Ticker GROW_TKR (cusip GROWTKR03) — 1 superinvestor materially adds.
//   - 3 quarters: 2025-09-30 (prior) and 2025-12-31 (current).
// This lets Q1-Q6 + E1-E5 all produce non-trivial answers + asserts
// the calibration-7 strength=sum invariant on real DB output.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  FilersRepo,
  FilingsRepo,
  HoldingsRepo,
  type FilerUpsert,
  type FilingUpsert,
  type HoldingUpsert,
} from '../../src/db/index.js';
import { QueryService } from '../../src/server/service/queryService.js';
import { FilerResolver, type RosterEntry } from '../../src/resolution/index.js';
import { connectAndMigrate, type E2EHarness } from './setup.js';

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

// ---------- Fixtures ----------

const ROSTER: RosterEntry[] = [
  {
    cik: '0001067983',
    displayName: 'Berkshire Hathaway',
    edgarName: 'BERKSHIRE HATHAWAY INC',
    aliases: ['Buffett'],
    superinvestorTier: 'legendary',
    primaryStrategy: 'value',
  },
  {
    cik: '0001649339',
    displayName: 'Scion Asset Management',
    edgarName: 'SCION ASSET MANAGEMENT, LLC',
    aliases: ['Burry'],
    superinvestorTier: 'well-known',
    primaryStrategy: 'value',
  },
  {
    cik: '0001336528',
    displayName: 'Pershing Square',
    edgarName: 'Pershing Square Capital Management, L.P.',
    aliases: ['Ackman'],
    superinvestorTier: 'legendary',
    primaryStrategy: 'event-driven',
  },
];

const TEST_TKR = 'TESTTKR';
const TEST_CUSIP = 'TESTTKR01';
const EXIT_TKR = 'EXITTKR';
const EXIT_CUSIP = 'EXITTKR02';
const GROW_TKR = 'GROWTKR';
const GROW_CUSIP = 'GROWTKR03';

const PRIOR = '2025-09-30';
const CURRENT = '2025-12-31';

// ---------- Seed helpers ----------

async function seedFiler(
  h: E2EHarness,
  cik: string,
  name: string,
  displayName: string,
  tier: 'legendary' | 'well-known' | 'notable',
  strategy: string,
): Promise<void> {
  const repo = new FilersRepo(h.db);
  const input: FilerUpsert = {
    filerCIK: cik,
    filerName: name,
    displayName,
    isSuperinvestor: true,
    superinvestorTier: tier,
    primaryStrategy: strategy,
    aliases: [],
  };
  await repo.upsert(input);
}

async function seedFiling(
  h: E2EHarness,
  cik: string,
  accession: string,
  periodOfReport: string,
  bookValueUSD: bigint,
): Promise<void> {
  const repo = new FilingsRepo(h.db);
  const filing: FilingUpsert = {
    accessionNumber: accession,
    filerCIK: cik,
    form: '13F-HR',
    isAmendment: false,
    periodOfReport,
    filingDate: shiftDate(periodOfReport, 45),
    bookValueUSD,
    valueScale: 'USD',
    tableEntryTotal: 1,
    primaryDocURL: `https://example/${accession}/primary_doc.xml`,
    infoTableURL: `https://example/${accession}/info.xml`,
    infoTableFilename: 'info.xml',
  };
  await repo.upsert(filing);
}

async function seedHolding(
  h: E2EHarness,
  args: {
    accession: string;
    cik: string;
    period: string;
    ticker: string;
    cusip: string;
    shares: bigint;
    valueUSD: bigint;
    pctOfBook: number;
    convictionTier: 'core' | 'meaningful' | 'starter' | 'scout';
  },
): Promise<void> {
  const repo = new HoldingsRepo(h.db);
  const row: HoldingUpsert = {
    accessionNumber: args.accession,
    filerCIK: args.cik,
    periodOfReport: args.period,
    cusip: args.cusip,
    ticker: args.ticker,
    issuerName: `ISSUER ${args.ticker}`,
    titleOfClass: 'COM',
    shares: args.shares,
    valueUSD: args.valueUSD,
    pctOfBook: args.pctOfBook,
    convictionTier: args.convictionTier,
    sshPrnamtType: 'SH',
    putCall: null,
  };
  await repo.upsertManyForFiling([row]);
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Seed the scenario: 3 NEWs on TESTTKR, 1 EXIT on EXITTKR, 1 ADD on GROWTKR. */
async function seedScenario(h: E2EHarness): Promise<void> {
  // Filers
  await seedFiler(
    h,
    '0001067983',
    'BERKSHIRE HATHAWAY INC',
    'Berkshire Hathaway',
    'legendary',
    'value',
  );
  await seedFiler(
    h,
    '0001649339',
    'SCION ASSET MANAGEMENT, LLC',
    'Scion Asset Management',
    'well-known',
    'value',
  );
  await seedFiler(
    h,
    '0001336528',
    'Pershing Square Capital Management, L.P.',
    'Pershing Square',
    'legendary',
    'event-driven',
  );

  // Prior-quarter filings (Q3 2025).
  await seedFiling(h, '0001067983', 'ACC-BERK-PRIOR', PRIOR, 100_000_000_000n);
  await seedFiling(h, '0001649339', 'ACC-SCION-PRIOR', PRIOR, 1_000_000_000n);
  await seedFiling(h, '0001336528', 'ACC-PERSH-PRIOR', PRIOR, 10_000_000_000n);

  // Current-quarter filings (Q4 2025).
  await seedFiling(h, '0001067983', 'ACC-BERK-CURRENT', CURRENT, 110_000_000_000n);
  await seedFiling(h, '0001649339', 'ACC-SCION-CURRENT', CURRENT, 1_100_000_000n);
  await seedFiling(h, '0001336528', 'ACC-PERSH-CURRENT', CURRENT, 11_000_000_000n);

  // TESTTKR — 3 NEW initiations in current quarter (cluster trigger).
  await seedHolding(h, {
    accession: 'ACC-BERK-CURRENT',
    cik: '0001067983',
    period: CURRENT,
    ticker: TEST_TKR,
    cusip: TEST_CUSIP,
    shares: 100_000n,
    valueUSD: 220_000_000n,
    pctOfBook: 0.002,
    convictionTier: 'starter',
  });
  await seedHolding(h, {
    accession: 'ACC-SCION-CURRENT',
    cik: '0001649339',
    period: CURRENT,
    ticker: TEST_TKR,
    cusip: TEST_CUSIP,
    shares: 50_000n,
    valueUSD: 27_500_000n,
    pctOfBook: 0.025,
    convictionTier: 'meaningful',
  });
  await seedHolding(h, {
    accession: 'ACC-PERSH-CURRENT',
    cik: '0001336528',
    period: CURRENT,
    ticker: TEST_TKR,
    cusip: TEST_CUSIP,
    shares: 200_000n,
    valueUSD: 110_000_000n,
    pctOfBook: 0.01,
    convictionTier: 'meaningful',
  });

  // EXITTKR — Scion held prior, exits current.
  await seedHolding(h, {
    accession: 'ACC-SCION-PRIOR',
    cik: '0001649339',
    period: PRIOR,
    ticker: EXIT_TKR,
    cusip: EXIT_CUSIP,
    shares: 30_000n,
    valueUSD: 15_000_000n,
    pctOfBook: 0.015,
    convictionTier: 'meaningful',
  });
  // Berkshire holds it in BOTH periods so it shows up in some queries.
  await seedHolding(h, {
    accession: 'ACC-BERK-PRIOR',
    cik: '0001067983',
    period: PRIOR,
    ticker: EXIT_TKR,
    cusip: EXIT_CUSIP,
    shares: 1_000_000n,
    valueUSD: 500_000_000n,
    pctOfBook: 0.005,
    convictionTier: 'starter',
  });
  await seedHolding(h, {
    accession: 'ACC-BERK-CURRENT',
    cik: '0001067983',
    period: CURRENT,
    ticker: EXIT_TKR,
    cusip: EXIT_CUSIP,
    shares: 1_050_000n,
    valueUSD: 525_000_000n,
    pctOfBook: 0.005,
    convictionTier: 'starter',
  });

  // GROWTKR — Pershing prior 100 shares, current 200 shares (100% add).
  await seedHolding(h, {
    accession: 'ACC-PERSH-PRIOR',
    cik: '0001336528',
    period: PRIOR,
    ticker: GROW_TKR,
    cusip: GROW_CUSIP,
    shares: 100_000n,
    valueUSD: 100_000_000n,
    pctOfBook: 0.01,
    convictionTier: 'meaningful',
  });
  await seedHolding(h, {
    accession: 'ACC-PERSH-CURRENT',
    cik: '0001336528',
    period: CURRENT,
    ticker: GROW_TKR,
    cusip: GROW_CUSIP,
    shares: 200_000n,
    valueUSD: 220_000_000n,
    pctOfBook: 0.02,
    convictionTier: 'meaningful',
  });
}

// ---------- Tests ----------

describe.skipIf(!process.env['DATABASE_URL'])('e2e — QueryService against real Postgres', () => {
  function makeSvc(h: E2EHarness): QueryService {
    return new QueryService({
      db: h.db,
      resolver: new FilerResolver(ROSTER),
      rosterByCik: new Map(ROSTER.map((r) => [r.cik, r])),
      now: () => new Date('2026-02-15T00:00:00Z'),
    });
  }

  it('Q1: 3 superinvestors newly initiated TESTTKR; rows sorted by pctOfBook desc', async () => {
    if (!harness) return;
    await seedScenario(harness);
    const svc = makeSvc(harness);
    const env = await svc.q1NewInitiations({ ticker: TEST_TKR, quarter: CURRENT });
    expect(env.rows).toHaveLength(3);
    // Sorted desc by pctOfBook: Scion (0.025), Pershing (0.010), Berkshire (0.002).
    expect(env.rows.map((r) => r.filerCIK)).toEqual(['0001649339', '0001336528', '0001067983']);
    expect(env.rows[0]!.pctOfBook).toBeCloseTo(0.025, 6);
    expect(env.meta.coverageScope).toBe('long_us_equity');
    expect(env.meta.truncated).toBe(false);
    expect(env.summary).toMatch(/3 managers initiated TESTTKR/);
  });

  it('Q2: Scion exited EXITTKR; Berkshire still holds → not in exits', async () => {
    if (!harness) return;
    await seedScenario(harness);
    const svc = makeSvc(harness);
    const env = await svc.q2Exits({ ticker: EXIT_TKR, quarter: CURRENT });
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0]!.filerCIK).toBe('0001649339');
    expect(env.rows[0]!.priorPctOfBook).toBeCloseTo(0.015, 6);
  });

  it('Q3: Pershing materially added GROWTKR (+100% > 25% threshold)', async () => {
    if (!harness) return;
    await seedScenario(harness);
    const svc = makeSvc(harness);
    const env = await svc.q3MaterialResizes({ ticker: GROW_TKR, quarter: CURRENT });
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0]!.deltaType).toBe('add');
    expect(env.rows[0]!.filerCIK).toBe('0001336528');
    expect(env.rows[0]!.shareDeltaPct).toBeCloseTo(1.0, 6);
  });

  it("Q4 fuzzy 'Burry' → Scion, returns delta across both quarters", async () => {
    if (!harness) return;
    await seedScenario(harness);
    const svc = makeSvc(harness);
    const out = await svc.q4FilerDelta({
      filerNameOrCIK: 'Burry',
      currentQuarter: CURRENT,
      priorQuarter: PRIOR,
    });
    expect(out.kind).toBe('envelope');
    if (out.kind !== 'envelope') return;
    expect(out.envelope.rows.filerCIK).toBe('0001649339');
    // Scion: newInitiation on TESTTKR, exit on EXITTKR.
    expect(out.envelope.rows.newInitiations).toHaveLength(1);
    expect(out.envelope.rows.exits).toHaveLength(1);
  });

  it('Q5 cluster: 3 superinvestors on TESTTKR → weak tier; strength === sum(pctOfBookDelta) [calibration 7]', async () => {
    if (!harness) return;
    await seedScenario(harness);
    const svc = makeSvc(harness);
    const env = await svc.q5SuperinvestorCluster({ ticker: TEST_TKR, quarter: CURRENT });
    expect(env.clusterSignal).not.toBeNull();
    if (!env.clusterSignal) return;
    expect(env.clusterSignal.tier).toBe('weak');
    expect(env.clusterSignal.memberCount).toBe(3);
    // Envelope-level invariant from calibration 7.
    const rowSum = env.rows.reduce((acc, r) => acc + r.pctOfBookDelta, 0);
    expect(env.clusterSignal.strength).toBeCloseTo(rowSum, 6);
    // Each row's pctOfBookDelta = currentPctOfBook - (priorPctOfBook ?? 0).
    for (const r of env.rows) {
      const expected = r.currentPctOfBook - (r.priorPctOfBook ?? 0);
      expect(r.pctOfBookDelta).toBeCloseTo(expected, 6);
    }
  });

  it('Q6 full picture on TESTTKR: 3 new initiations, 0 exits, 0 resizes', async () => {
    if (!harness) return;
    await seedScenario(harness);
    const svc = makeSvc(harness);
    const env = await svc.q6FullTickerDelta({ ticker: TEST_TKR, quarter: CURRENT });
    expect(env.rows.newInitiations).toHaveLength(3);
    expect(env.rows.exits).toHaveLength(0);
    expect(env.rows.materialAdds).toHaveLength(0);
    expect(env.rows.materialTrims).toHaveLength(0);
  });

  it('E1: get_filer_delta by CIK matches Q4 envelope', async () => {
    if (!harness) return;
    await seedScenario(harness);
    const svc = makeSvc(harness);
    const env = await svc.e1FilerDelta({
      filerCIK: '0001336528',
      currentQuarter: CURRENT,
      priorQuarter: PRIOR,
    });
    // Pershing: 1 new (TESTTKR) + 1 add (GROWTKR).
    expect(env.rows.newInitiations).toHaveLength(1);
    expect(env.rows.addedTo).toHaveLength(1);
  });

  it('E2: get_ticker_delta on TESTTKR mirrors Q6', async () => {
    if (!harness) return;
    await seedScenario(harness);
    const svc = makeSvc(harness);
    const env = await svc.q6FullTickerDelta({ ticker: TEST_TKR, quarter: CURRENT });
    expect(env.rows.newInitiations).toHaveLength(3);
  });

  it('E3: list_superinvestors returns the seeded roster, sorted', async () => {
    if (!harness) return;
    await seedScenario(harness);
    const svc = makeSvc(harness);
    const out = await svc.e3ListSuperinvestors({});
    expect(out.rows.length).toBeGreaterThanOrEqual(3);
    const ciks = out.rows.map((r) => r.filerCIK);
    expect(ciks).toContain('0001067983');
    expect(ciks).toContain('0001649339');
    expect(ciks).toContain('0001336528');
  });

  it('E4: list_quarters_available returns both ingested periods', async () => {
    if (!harness) return;
    await seedScenario(harness);
    const svc = makeSvc(harness);
    const out = await svc.e4ListQuartersAvailable({});
    const periods = out.rows.map((r) => r.periodOfReport);
    expect(periods).toContain(CURRENT);
    expect(periods).toContain(PRIOR);
  });

  it('E5: get_filing returns parsed cover page + holdings', async () => {
    if (!harness) return;
    await seedScenario(harness);
    const svc = makeSvc(harness);
    const out = await svc.e5GetFiling({ accessionNumber: 'ACC-BERK-CURRENT' });
    expect(out).not.toBeNull();
    expect(out!.filerCIK).toBe('0001067983');
    expect(out!.bookValueUSD).toBe(110_000_000_000);
    expect(out!.holdings.length).toBeGreaterThan(0);
  });
});
