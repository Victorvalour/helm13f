// Repository unit tests — verify SQL composition + parameter binding
// against a stub QueryRunner. Real-Postgres integration suite lands
// alongside docker-compose in the e2e step (12).

import { describe, it, expect } from 'vitest';
import {
  CusipTickerMapRepo,
  DeltaCacheRepo,
  FilersRepo,
  FilingsRepo,
  HoldingsRepo,
  IngestionLogRepo,
  normalizeFilerName,
} from '../../src/db/index.js';
import type { QueryRunner } from '../../src/db/index.js';

interface RecordedQuery {
  text: string;
  values: unknown[];
}

class StubQueryRunner implements QueryRunner {
  public readonly queries: RecordedQuery[] = [];
  public responses: Array<{ rows: unknown[]; rowCount?: number }> = [];

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
    const next = this.responses.shift() ?? { rows: [] };
    return {
      rows: next.rows as R[],
      rowCount: next.rowCount ?? next.rows.length,
      command: 'SELECT',
      oid: 0,
      fields: [],
    };
  }
}

const FIXED_NOW = new Date('2026-05-04T00:00:00Z');

// =====================================================================
// FilersRepo
// =====================================================================
describe('FilersRepo', () => {
  it('upsert sets pairing isSuperinvestor=true / tier=legendary', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [
      {
        rows: [
          {
            filer_cik: '0001067983',
            filer_name: 'BERKSHIRE HATHAWAY INC',
            normalized_name: 'berkshire hathaway',
            display_name: 'Berkshire Hathaway',
            is_superinvestor: true,
            superinvestor_tier: 'legendary',
            primary_strategy: 'value',
            aliases: ['Buffett'],
            last_seen_at: FIXED_NOW,
          },
        ],
      },
    ];
    const repo = new FilersRepo(stub);
    const out = await repo.upsert({
      filerCIK: '0001067983',
      filerName: 'BERKSHIRE HATHAWAY INC',
      displayName: 'Berkshire Hathaway',
      isSuperinvestor: true,
      superinvestorTier: 'legendary',
      primaryStrategy: 'value',
      aliases: ['Buffett'],
      seenAt: FIXED_NOW,
    });
    expect(out.isSuperinvestor).toBe(true);
    expect(out.superinvestorTier).toBe('legendary');
    expect(stub.queries).toHaveLength(1);
    const q = stub.queries[0]!;
    expect(q.text).toContain('INSERT INTO filers');
    expect(q.text).toContain('ON CONFLICT (filer_cik) DO UPDATE');
    expect(q.values[4]).toBe(true); // is_superinvestor
    expect(q.values[5]).toBe('legendary'); // tier
  });

  it('upsert rejects isSuperinvestor=true without a tier', async () => {
    const repo = new FilersRepo(new StubQueryRunner());
    await expect(
      repo.upsert({
        filerCIK: '0001067983',
        filerName: 'X',
        isSuperinvestor: true,
      }),
    ).rejects.toThrow(/superinvestorTier required/);
  });

  it('upsert rejects isSuperinvestor=false with a tier', async () => {
    const repo = new FilersRepo(new StubQueryRunner());
    await expect(
      repo.upsert({
        filerCIK: '0001067983',
        filerName: 'X',
        isSuperinvestor: false,
        superinvestorTier: 'legendary',
      }),
    ).rejects.toThrow(/must be null/);
  });

  it('listSuperinvestors with tier filter parameterizes the query', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [{ rows: [] }];
    const repo = new FilersRepo(stub);
    await repo.listSuperinvestors({
      tier: 'legendary',
      strategySubstring: 'value',
    });
    const q = stub.queries[0]!;
    expect(q.text).toContain('is_superinvestor = TRUE');
    expect(q.text).toContain('superinvestor_tier = $1');
    expect(q.text).toContain('LOWER(primary_strategy) LIKE $2');
    expect(q.values).toEqual(['legendary', '%value%']);
  });
});

describe('normalizeFilerName', () => {
  it('lowercases, strips punctuation and corporate suffixes', () => {
    expect(normalizeFilerName('Berkshire Hathaway Inc.')).toBe('berkshire hathaway');
    expect(normalizeFilerName('Pershing Square Capital Management, L.P.')).toBe('pershing square');
    expect(normalizeFilerName('SCION ASSET MANAGEMENT, LLC')).toBe('scion asset');
  });

  it('collapses whitespace', () => {
    expect(normalizeFilerName('  Foo   Bar  Inc  ')).toBe('foo bar');
  });
});

// =====================================================================
// FilingsRepo
// =====================================================================
describe('FilingsRepo', () => {
  it('upsert serializes BigInt bookValueUSD as a string parameter', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [
      {
        rows: [
          {
            accession_number: '0001193125-26-054580',
            filer_cik: '0001067983',
            form: '13F-HR',
            is_amendment: false,
            superseded_by_accession: null,
            period_of_report: '2025-12-31',
            filing_date: '2026-02-17',
            book_value_usd: '274160086701',
            value_scale: 'USD',
            table_entry_total: 110,
            primary_doc_url: 'https://x',
            info_table_url: 'https://y',
            info_table_filename: '50240.xml',
            raw_xml_sha256: null,
            ingested_at: FIXED_NOW,
          },
        ],
      },
    ];
    const repo = new FilingsRepo(stub);
    const out = await repo.upsert({
      accessionNumber: '0001193125-26-054580',
      filerCIK: '0001067983',
      form: '13F-HR',
      isAmendment: false,
      periodOfReport: '2025-12-31',
      filingDate: '2026-02-17',
      bookValueUSD: 274_160_086_701n,
      valueScale: 'USD',
      tableEntryTotal: 110,
      primaryDocURL: 'https://x',
      infoTableURL: 'https://y',
      infoTableFilename: '50240.xml',
    });
    expect(out.bookValueUSD).toBe(274_160_086_701n);
    const q = stub.queries[0]!;
    // BigInt is passed as string to keep precision through pg's binding.
    expect(q.values[6]).toBe('274160086701');
  });

  it('getActive filters on superseded_by_accession IS NULL', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [{ rows: [] }];
    const repo = new FilingsRepo(stub);
    await repo.getActive('0001067983', '2025-12-31');
    expect(stub.queries[0]!.text).toContain('superseded_by_accession IS NULL');
  });

  it('markSuperseded writes the supersession pointer', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [{ rows: [], rowCount: 1 }];
    const repo = new FilingsRepo(stub);
    await repo.markSuperseded('OLD', 'NEW');
    expect(stub.queries[0]!.text).toContain('UPDATE filings SET superseded_by_accession');
    expect(stub.queries[0]!.values).toEqual(['OLD', 'NEW']);
  });
});

// =====================================================================
// HoldingsRepo
// =====================================================================
describe('HoldingsRepo', () => {
  it('upsertManyForFiling writes a multi-row INSERT with 17 columns each', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [{ rows: [], rowCount: 2 }];
    const repo = new HoldingsRepo(stub);
    const n = await repo.upsertManyForFiling([
      {
        accessionNumber: '0001193125-26-054580',
        filerCIK: '0001067983',
        periodOfReport: '2025-12-31',
        cusip: '037833100',
        ticker: 'AAPL',
        issuerName: 'APPLE INC',
        titleOfClass: 'COM',
        shares: 100n,
        valueUSD: 5000n,
        pctOfBook: 0.0123,
        convictionTier: 'meaningful',
        sshPrnamtType: 'SH',
        putCall: null,
      },
      {
        accessionNumber: '0001193125-26-054580',
        filerCIK: '0001067983',
        periodOfReport: '2025-12-31',
        cusip: '02005N100',
        ticker: 'ALLY',
        issuerName: 'ALLY FINL INC',
        titleOfClass: 'COM',
        shares: 29_000_000n,
        valueUSD: 1_313_410_001n,
        pctOfBook: 0.0048,
        convictionTier: 'starter',
        sshPrnamtType: 'SH',
        putCall: null,
      },
    ]);
    expect(n).toBe(2);
    const q = stub.queries[0]!;
    expect(q.text).toContain('INSERT INTO holdings');
    expect(q.text).toContain('ON CONFLICT (accession_number, cusip, put_call) DO UPDATE');
    // 2 rows × 17 cols = 34 params.
    expect(q.values).toHaveLength(34);
  });

  it('upsertManyForFiling chunks at 500 rows to stay under pg parameter limit', async () => {
    // 1200 rows × 17 cols = 20400 params if unchunked — overflows pg's
    // 16-bit parameter-count field. With CHUNK=500, expect 3 statements.
    const stub = new StubQueryRunner();
    stub.responses = [
      { rows: [], rowCount: 500 },
      { rows: [], rowCount: 500 },
      { rows: [], rowCount: 200 },
    ];
    const repo = new HoldingsRepo(stub);
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      accessionNumber: '0001193125-26-054580',
      filerCIK: '0001067983',
      periodOfReport: '2025-12-31',
      cusip: String(i).padStart(9, '0'),
      ticker: 'X' + i,
      issuerName: 'X',
      titleOfClass: 'COM',
      shares: 1n,
      valueUSD: 1n,
      pctOfBook: 0,
      convictionTier: 'scout' as const,
      sshPrnamtType: 'SH' as const,
      putCall: null,
    }));
    const n = await repo.upsertManyForFiling(rows);
    expect(n).toBe(1200);
    expect(stub.queries).toHaveLength(3);
    expect(stub.queries[0]!.values).toHaveLength(500 * 17);
    expect(stub.queries[1]!.values).toHaveLength(500 * 17);
    expect(stub.queries[2]!.values).toHaveLength(200 * 17);
  });

  it('listActiveByTicker joins through the active-filings subquery', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [{ rows: [] }];
    const repo = new HoldingsRepo(stub);
    await repo.listActiveByTicker('AAPL', '2025-12-31');
    const q = stub.queries[0]!;
    expect(q.text).toContain('superseded_by_accession IS NULL');
    expect(q.text).toContain('ticker = $1');
    expect(q.text).toContain('period_of_report = $2');
    expect(q.values).toEqual(['AAPL', '2025-12-31']);
  });

  it('setTickerForCusip skips no-op writes (DISTINCT FROM guard)', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [{ rows: [], rowCount: 0 }];
    const repo = new HoldingsRepo(stub);
    const n = await repo.setTickerForCusip('037833100', 'AAPL');
    expect(n).toBe(0);
    expect(stub.queries[0]!.text).toContain('IS DISTINCT FROM');
  });
});

// =====================================================================
// CusipTickerMapRepo (CusipCache adapter)
// =====================================================================
describe('CusipTickerMapRepo (Postgres CusipCache adapter)', () => {
  it('getMany populates null for unknown cusips', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [
      {
        rows: [
          {
            cusip: '037833100',
            ticker: 'AAPL',
            issuer_name: 'APPLE INC',
            source: 'company_tickers',
            last_verified_at: FIXED_NOW,
          },
        ],
      },
    ];
    const repo = new CusipTickerMapRepo(stub);
    const out = await repo.getMany(['037833100', '02005N100']);
    expect(out.get('037833100')?.ticker).toBe('AAPL');
    expect(out.get('02005N100')).toBeNull();
    expect(stub.queries[0]!.text).toContain('cusip = ANY($1::text[])');
  });

  it('setMany writes a multi-row insert with ON CONFLICT update', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [{ rows: [], rowCount: 2 }];
    const repo = new CusipTickerMapRepo(stub);
    await repo.setMany([
      {
        cusip: '037833100',
        ticker: 'AAPL',
        issuerName: 'APPLE INC',
        source: 'openfigi',
        lastVerifiedAt: FIXED_NOW,
      },
      {
        cusip: '02005N100',
        ticker: null,
        issuerName: null,
        source: 'openfigi',
        lastVerifiedAt: FIXED_NOW,
      },
    ]);
    const q = stub.queries[0]!;
    expect(q.text).toContain('ON CONFLICT (cusip) DO UPDATE');
    expect(q.values).toHaveLength(10);
  });
});

// =====================================================================
// DeltaCacheRepo
// =====================================================================
describe('DeltaCacheRepo', () => {
  it('get filters by schema_version and active expiry', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [{ rows: [] }];
    const repo = new DeltaCacheRepo(stub, 1);
    await repo.get('ticker:AAPL|2025-12-31|2025-09-30');
    const q = stub.queries[0]!;
    expect(q.text).toContain('schema_version = $2');
    expect(q.text).toContain('expires_at IS NULL OR expires_at > NOW()');
    expect(q.values).toEqual(['ticker:AAPL|2025-12-31|2025-09-30', 1]);
  });

  it('set serializes payload as JSON in a $::jsonb cast', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [{ rows: [], rowCount: 1 }];
    const repo = new DeltaCacheRepo(stub, 1);
    await repo.set('k', { foo: 'bar' }, { inputsFingerprint: 'fp1' });
    const q = stub.queries[0]!;
    expect(q.text).toContain('$2::jsonb');
    expect(q.values[1]).toBe('{"foo":"bar"}');
    expect(q.values[2]).toBe('fp1');
  });
});

// =====================================================================
// IngestionLogRepo
// =====================================================================
describe('IngestionLogRepo', () => {
  it('start INSERTs and returns the new id', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [{ rows: [{ id: 42 }] }];
    const repo = new IngestionLogRepo(stub);
    const id = await repo.start('backfill', 'test note');
    expect(id).toBe(42);
    expect(stub.queries[0]!.text).toContain('INSERT INTO ingestion_log');
  });

  it('finish UPDATEs the row, computing duration_ms', async () => {
    const stub = new StubQueryRunner();
    stub.responses = [{ rows: [], rowCount: 1 }];
    const repo = new IngestionLogRepo(stub);
    await repo.finish(1, { filingsParsed: 10, holdingsUpserted: 350 });
    const q = stub.queries[0]!;
    expect(q.text).toContain('UPDATE ingestion_log');
    expect(q.text).toContain('duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000');
  });
});
