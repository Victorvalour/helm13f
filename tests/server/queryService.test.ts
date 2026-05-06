// QueryService tests against a stub Database. We exercise the orchestration:
//   - sorting + truncation per limit
//   - pctOfBook / convictionTier / delta classification flowing through
//   - cluster signal calibration-7 invariant (strength === sum of deltas)
//   - missing prior/current quarter populates gapSignals
//   - filer fuzzy resolution → 'ambiguous_filer' shape
//
// We don't validate against ajv here (the Phase 2 contract tests already
// pin every output schema); we DO assert the envelope shape the handlers
// will emit, end-to-end.

import { describe, it, expect, beforeEach } from 'vitest';
import { QueryService, type QueryServiceDeps } from '../../src/server/service/queryService.js';
import { FilerResolver, type RosterEntry } from '../../src/resolution/index.js';
import type { Database, QueryRunner } from '../../src/db/index.js';

// ------------------------------------------------------------
// Stub Database
// ------------------------------------------------------------

type Row = Record<string, unknown>;
type ResponseSpec = { rows: Row[]; rowCount?: number };

class StubDb implements Database {
  /** Map of regex → list of canned responses (FIFO). */
  private readonly recipes: Array<{
    re: RegExp;
    responses: ResponseSpec[];
  }> = [];
  public readonly queries: Array<{ text: string; values: unknown[] }> = [];

  on(re: RegExp, responses: ResponseSpec | ResponseSpec[]): void {
    this.recipes.push({
      re,
      responses: Array.isArray(responses) ? responses : [responses],
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query<R extends { [k: string]: unknown } = { [k: string]: unknown }>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{
    rows: R[];
    rowCount: number;
    command: string;
    oid: number;
    fields: never[];
  }> {
    this.queries.push({ text, values: values ? [...values] : [] });
    for (const r of this.recipes) {
      if (r.re.test(text)) {
        // FIFO consume when 2+ responses queued; last response is "sticky"
        // and repeats indefinitely. Lets a single canned response satisfy
        // arbitrarily many calls (e.g. fetchFiler) without forcing tests
        // to enumerate every per-CIK invocation.
        const next =
          r.responses.length > 1 ? r.responses.shift()! : (r.responses[0] ?? { rows: [] });
        return {
          rows: next.rows as R[],
          rowCount: next.rowCount ?? next.rows.length,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      }
    }
    return {
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    };
  }

  withTx<T>(fn: (client: QueryRunner) => Promise<T>): Promise<T> {
    return fn(this);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

const ROSTER: RosterEntry[] = [
  {
    cik: '0001067983',
    displayName: 'Berkshire Hathaway',
    edgarName: 'BERKSHIRE HATHAWAY INC',
    aliases: ['Buffett', 'Warren Buffett'],
    superinvestorTier: 'legendary',
    primaryStrategy: 'value',
  },
];

function dbRow(over: Partial<Row> = {}): Row {
  return {
    accession_number: '0001193125-26-054580',
    filer_cik: '0001067983',
    period_of_report: '2025-12-31',
    cusip: '037833100',
    ticker: 'AAPL',
    issuer_name: 'APPLE INC',
    title_of_class: 'COM',
    shares: '100',
    value_usd: '1000',
    pct_of_book: '0.012345',
    conviction_tier: 'meaningful',
    ssh_prnamt_type: 'SH',
    put_call: null,
    investment_discretion: 'SOLE',
    voting_sole: '100',
    voting_shared: '0',
    voting_none: '0',
    ...over,
  };
}

function filerDbRow(): Row {
  return {
    filer_cik: '0001067983',
    filer_name: 'BERKSHIRE HATHAWAY INC',
    normalized_name: 'berkshire hathaway',
    display_name: 'Berkshire Hathaway',
    is_superinvestor: true,
    superinvestor_tier: 'legendary',
    primary_strategy: 'value',
    aliases: ['Buffett'],
    last_seen_at: new Date(),
  };
}

function filingDbRow(over: Partial<Row> = {}): Row {
  return {
    accession_number: '0001193125-26-054580',
    filer_cik: '0001067983',
    form: '13F-HR',
    is_amendment: false,
    superseded_by_accession: null,
    period_of_report: '2025-12-31',
    filing_date: '2026-02-17',
    book_value_usd: '274160086701',
    value_scale: 'USD',
    table_entry_total: 1,
    primary_doc_url:
      'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/primary_doc.xml',
    info_table_url: 'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml',
    info_table_filename: '50240.xml',
    raw_xml_sha256: null,
    ingested_at: new Date(),
    ...over,
  };
}

function makeSvc(db: StubDb): QueryService {
  const deps: QueryServiceDeps = {
    db,
    resolver: new FilerResolver(ROSTER),
    rosterByCik: new Map(ROSTER.map((r) => [r.cik, r])),
    now: () => new Date('2026-05-04T00:00:00Z'),
  };
  return new QueryService(deps);
}

let db: StubDb;
let svc: QueryService;

beforeEach(() => {
  db = new StubDb();
  svc = makeSvc(db);

  // Common stubs used by every Q*: filers + filings + ingestion_log + meta.
  db.on(/FROM filers WHERE filer_cik = \$1/i, { rows: [filerDbRow()] });
  db.on(/SELECT MAX\(period_of_report\)/, {
    rows: [{ period_of_report: '2025-12-31' }],
  });
  // FilingsRepo.getActive — distinctive: filer_cik + LIMIT 1.
  db.on(/superseded_by_accession IS NULL[\s\S]*LIMIT 1/i, {
    rows: [filingDbRow()],
  });
  db.on(/FROM ingestion_log/i, { rows: [] });
  db.on(/SELECT COUNT\(DISTINCT filer_cik\)/i, {
    rows: [{ count: '4823' }],
  });
});

// ------------------------------------------------------------
// Q1
// ------------------------------------------------------------

describe('Q1 query_new_initiations_in_ticker', () => {
  it('returns rows for filers present in current but not prior', async () => {
    db.on(/WHERE ticker = \$1/i, [
      // current-quarter holdings
      {
        rows: [dbRow({ filer_cik: '0001067983', cusip: '73278L105', ticker: 'POOL' })],
      },
      // prior-quarter holdings (empty → filer hasn't held)
      { rows: [] },
    ]);

    const env = await svc.q1NewInitiations({ ticker: 'POOL' });
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0]?.filerCIK).toBe('0001067983');
    expect(env.rows[0]?.isSuperinvestor).toBe(true);
    expect(env.meta.coverageScope).toBe('long_us_equity');
    expect(env.meta.truncated).toBe(false);
    expect(env.clusterSignal).toBeNull();
    expect(env.summary).toContain('initiated POOL');
  });

  it('truncates at limit and reports truncated=true', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      dbRow({
        filer_cik: String(i).padStart(10, '0'),
        cusip: '73278L105',
        ticker: 'POOL',
        pct_of_book: String(0.001 + i * 0.0001),
      }),
    );
    db.on(/WHERE ticker = \$1/i, [
      { rows: many }, // current
      { rows: [] }, // prior
    ]);

    const env = await svc.q1NewInitiations({
      ticker: 'POOL',
      includeNonSuperinvestors: true,
      limit: 5,
    });
    expect(env.rows).toHaveLength(5);
    expect(env.meta.truncated).toBe(true);
    expect(env.meta.totalRowsAvailable).toBe(12);
    expect(env.meta.limitApplied).toBe(5);
    // Sorted desc by pctOfBook → first row has the highest pctOfBook.
    expect(env.rows[0]?.pctOfBook).toBeGreaterThan(env.rows[4]?.pctOfBook ?? 0);
  });
});

// ------------------------------------------------------------
// Q4 — fuzzy resolver path + ambiguous error shape
// ------------------------------------------------------------

describe('Q4 query_filer_quarter_delta', () => {
  it("'Buffett' resolves to Berkshire and produces a filer-axis envelope", async () => {
    db.on(/WHERE accession_number = \$1\s+ORDER BY pct_of_book DESC/i, [
      { rows: [dbRow()] }, // current filing holdings
      { rows: [] }, // prior filing holdings (empty → all rows are 'new')
    ]);

    const out = await svc.q4FilerDelta({ filerNameOrCIK: 'Buffett' });
    expect(out.kind).toBe('envelope');
    if (out.kind !== 'envelope') return;
    expect(out.envelope.rows.filerCIK).toBe('0001067983');
    expect(out.envelope.rows.newInitiations).toHaveLength(1);
    expect(out.envelope.rows.exits).toEqual([]);
    expect(out.envelope.meta.truncated).toBe(false);
  });

  it("ambiguous filer returns errorCode='ambiguous_filer' with candidates", async () => {
    const out = await svc.q4FilerDelta({ filerNameOrCIK: 'Capital' });
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.errorCode).toBe('ambiguous_filer');
  });

  it("missing-prior-quarter filing populates gapSignals='missing_prior_quarter_for_filer'", async () => {
    // The default filings stub returns the same filing for any (cik,
    // period). Override to return null only for the prior quarter (the
    // service calls getActive separately for each).
    db = new StubDb();
    svc = makeSvc(db);
    db.on(/SELECT MAX\(period_of_report\)/i, {
      rows: [{ period_of_report: '2025-12-31' }],
    });
    db.on(/FROM filers WHERE filer_cik = \$1/i, { rows: [filerDbRow()] });
    db.on(/FROM ingestion_log/i, { rows: [] });
    db.on(/SELECT COUNT\(DISTINCT filer_cik\)/i, {
      rows: [{ count: '4823' }],
    });
    // First lookup (current quarter): present. Second (prior): empty.
    db.on(/superseded_by_accession IS NULL[\s\S]*LIMIT 1/i, [
      { rows: [filingDbRow()] },
      { rows: [] },
    ]);
    db.on(/WHERE accession_number = \$1\s+ORDER BY pct_of_book DESC/i, [{ rows: [dbRow()] }]);

    const out = await svc.q4FilerDelta({ filerNameOrCIK: '0001067983' });
    expect(out.kind).toBe('envelope');
    if (out.kind !== 'envelope') return;
    expect(out.envelope.confidence.gapSignals).toContain('missing_prior_quarter_for_filer');
    expect(out.envelope.confidence.level).not.toBe('high');
  });
});

// ------------------------------------------------------------
// Q5 — cluster invariant
// ------------------------------------------------------------

describe('Q5 query_superinvestor_cluster_on_ticker', () => {
  it('strength === sum(rows[i].pctOfBookDelta) for a 3-member synthetic cluster', async () => {
    const roster: RosterEntry[] = [
      {
        cik: '0001067983',
        displayName: 'Berkshire',
        edgarName: 'BERKSHIRE HATHAWAY INC',
        aliases: [],
        superinvestorTier: 'legendary',
        primaryStrategy: 'value',
      },
      {
        cik: '0001649339',
        displayName: 'Scion',
        edgarName: 'SCION ASSET MANAGEMENT, LLC',
        aliases: [],
        superinvestorTier: 'well-known',
        primaryStrategy: 'value',
      },
      {
        cik: '0001336528',
        displayName: 'Pershing',
        edgarName: 'Pershing Square Capital Management, L.P.',
        aliases: [],
        superinvestorTier: 'legendary',
        primaryStrategy: 'event-driven',
      },
    ];
    const db2 = new StubDb();
    const svc2 = new QueryService({
      db: db2,
      resolver: new FilerResolver(roster),
      rosterByCik: new Map(roster.map((r) => [r.cik, r])),
      now: () => new Date('2026-05-04T00:00:00Z'),
    });

    db2.on(/SELECT MAX\(period_of_report\)/i, {
      rows: [{ period_of_report: '2025-12-31' }],
    });
    // Every superinvestor has a current-quarter NEW hit on POOL.
    db2.on(/WHERE ticker = \$1/i, [
      {
        rows: [
          dbRow({
            filer_cik: '0001067983',
            cusip: '73278L105',
            ticker: 'POOL',
            pct_of_book: '0.001800',
          }),
          dbRow({
            filer_cik: '0001649339',
            cusip: '73278L105',
            ticker: 'POOL',
            pct_of_book: '0.025000',
          }),
          dbRow({
            filer_cik: '0001336528',
            cusip: '73278L105',
            ticker: 'POOL',
            pct_of_book: '0.011000',
          }),
        ],
      },
      { rows: [] }, // prior quarter: nobody held POOL
    ]);
    db2.on(/FROM filers WHERE filer_cik = \$1/i, [
      { rows: [{ ...filerDbRow(), filer_cik: '0001067983' }] },
      { rows: [{ ...filerDbRow(), filer_cik: '0001649339', superinvestor_tier: 'well-known' }] },
      { rows: [{ ...filerDbRow(), filer_cik: '0001336528' }] },
    ]);
    db2.on(/superseded_by_accession IS NULL[\s\S]*LIMIT 1/i, {
      rows: [filingDbRow()],
    });
    db2.on(/FROM ingestion_log/i, { rows: [] });
    db2.on(/SELECT COUNT\(DISTINCT filer_cik\)/i, {
      rows: [{ count: '4823' }],
    });

    const env = await svc2.q5SuperinvestorCluster({ ticker: 'POOL' });
    expect(env.clusterSignal).not.toBeNull();
    if (!env.clusterSignal) return;
    expect(env.clusterSignal.tier).toBe('weak');
    expect(env.clusterSignal.memberCount).toBe(3);
    const rowSum = env.rows.reduce((acc, r) => acc + r.pctOfBookDelta, 0);
    expect(env.clusterSignal.strength).toBeCloseTo(rowSum, 6);
    // Every row's pctOfBookDelta = currentPctOfBook - (priorPctOfBook ?? 0).
    for (const r of env.rows) {
      const expected = r.currentPctOfBook - (r.priorPctOfBook ?? 0);
      expect(r.pctOfBookDelta).toBeCloseTo(expected, 6);
    }
  });

  it('emits clusterSignal=null when fewer than 3 superinvestors qualify', async () => {
    db.on(/WHERE ticker = \$1/i, [
      {
        rows: [
          dbRow({ filer_cik: '0001067983', ticker: 'POOL' }),
          dbRow({ filer_cik: '0009999999', ticker: 'POOL' }),
        ],
      },
      { rows: [] },
    ]);

    const env = await svc.q5SuperinvestorCluster({ ticker: 'POOL' });
    expect(env.clusterSignal).toBeNull();
    expect(env.summary).toContain('No cluster detected');
  });
});

// ------------------------------------------------------------
// E5 get_filing
// ------------------------------------------------------------

describe('E5 get_filing', () => {
  it('returns null when accession not found', async () => {
    db.on(/FROM filings WHERE accession_number = \$1/i, { rows: [] });
    const out = await svc.e5GetFiling({
      accessionNumber: '0000000000-00-000000',
    });
    expect(out).toBeNull();
  });

  it('returns the filing + holdings when present', async () => {
    db.on(/FROM filings WHERE accession_number = \$1/i, {
      rows: [filingDbRow()],
    });
    db.on(/WHERE accession_number = \$1\s+ORDER BY pct_of_book DESC/i, {
      rows: [dbRow()],
    });
    const out = await svc.e5GetFiling({
      accessionNumber: '0001193125-26-054580',
    });
    expect(out).not.toBeNull();
    expect(out?.bookValueUSD).toBe(274_160_086_701);
    expect(out?.holdings).toHaveLength(1);
    expect(out?.valueScale).toBe('USD');
  });
});
