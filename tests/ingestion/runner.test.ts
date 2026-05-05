// runIngestion orchestration tests with mocked EDGAR + stub Database +
// stub CUSIP resolver.
//
// We don't exercise the per-filing parse/persist machinery here (those
// have their own dedicated tests). What we verify is the orchestration:
// per-filer + per-filing errors are caught, run completes, and the
// ingestion_log row is started + finished with accurate counts.

import { describe, it, expect } from 'vitest';
import { runIngestion } from '../../src/ingestion/index.js';
import type { Database, QueryRunner } from '../../src/db/index.js';
import type { EdgarClient, EdgarSubmissions } from '../../src/sources/edgar/index.js';
import type { CusipResolver, CusipRecord } from '../../src/sources/openfigi/index.js';

interface RecordedQuery {
  text: string;
  values: unknown[];
}

class StubDb implements Database {
  public readonly queries: RecordedQuery[] = [];
  public ingestionLogId = 99;

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
    if (text.includes('INSERT INTO ingestion_log')) {
      return {
        rows: [{ id: this.ingestionLogId } as unknown as R],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };
    }
    if (text.includes('UPDATE ingestion_log')) {
      return {
        rows: [],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      };
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

const SAMPLE_SUBS: EdgarSubmissions = {
  cik: '0001067983',
  name: 'BERKSHIRE HATHAWAY INC',
  filings: {
    recent: {
      accessionNumber: ['0001193125-26-054580'],
      filingDate: ['2026-02-17'],
      form: ['13F-HR'],
      primaryDocument: ['primary_doc.xml'],
      periodOfReport: ['2025-12-31'],
    },
    files: [],
  },
};

function makeEdgarThatThrowsOnFetch(): EdgarClient {
  return {
    getSubmissions: () => Promise.resolve(SAMPLE_SUBS),
    getFilingFile: () => Promise.reject(new Error('synthetic fetch failure')),
    getFilingIndex: () => Promise.reject(new Error('not reached')),
    getSubmissionsPage: () => Promise.reject(new Error('not used')),
    getCompanyTickers: () => Promise.reject(new Error('not used')),
    fullTextSearch: () => Promise.reject(new Error('not used')),
  } as unknown as EdgarClient;
}

function makeStubResolver(): CusipResolver {
  return {
    resolve: (_c: string) => Promise.resolve(null as unknown as CusipRecord),
    resolveBatch: (cusips: readonly string[]) => {
      const out = new Map<string, CusipRecord>();
      for (const c of cusips) {
        out.set(c, {
          cusip: c,
          ticker: null,
          issuerName: null,
          source: 'openfigi',
          lastVerifiedAt: new Date(),
        });
      }
      return Promise.resolve(out);
    },
  } as unknown as CusipResolver;
}

describe('runIngestion — orchestration', () => {
  it('starts and finishes the ingestion_log row exactly once', async () => {
    const db = new StubDb();
    const edgar = makeEdgarThatThrowsOnFetch();
    const resolver = makeStubResolver();
    await runIngestion(
      {
        filerCIKs: ['0001067983'],
        targetPeriods: ['2025-12-31'],
        runKind: 'manual',
      },
      db,
      edgar,
      resolver,
    );
    const inserts = db.queries.filter((q) => q.text.includes('INSERT INTO ingestion_log'));
    const updates = db.queries.filter((q) => q.text.includes('UPDATE ingestion_log'));
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });

  it('counts per-filing fetch failures as parseErrors and continues', async () => {
    const db = new StubDb();
    const edgar = makeEdgarThatThrowsOnFetch();
    const resolver = makeStubResolver();
    const summary = await runIngestion(
      {
        filerCIKs: ['0001067983'],
        targetPeriods: ['2025-12-31'],
        runKind: 'manual',
      },
      db,
      edgar,
      resolver,
    );
    expect(summary.filingsDiscovered).toBe(1);
    expect(summary.filingsParsed).toBe(0);
    expect(summary.parseErrors).toBe(1);
    expect(summary.errorSamples).toHaveLength(1);
    expect(summary.errorSamples[0]?.error).toContain('synthetic fetch failure');
  });

  it('captures discover-step failures separately', async () => {
    const edgar = {
      getSubmissions: () => Promise.reject(new Error('discover blew up')),
    } as unknown as EdgarClient;
    const db = new StubDb();
    const resolver = makeStubResolver();
    const summary = await runIngestion(
      {
        filerCIKs: ['0001067983'],
        targetPeriods: ['2025-12-31'],
        runKind: 'daily',
      },
      db,
      edgar,
      resolver,
    );
    expect(summary.filingsDiscovered).toBe(0);
    expect(summary.parseErrors).toBe(1);
    expect(summary.errorSamples[0]?.accessionNumber).toBe('');
    expect(summary.errorSamples[0]?.error).toMatch(/discover/);
  });

  it('returns ingestionLogId from the start() call', async () => {
    const db = new StubDb();
    db.ingestionLogId = 1234;
    const summary = await runIngestion(
      {
        filerCIKs: [],
        targetPeriods: [],
        runKind: 'backfill',
      },
      db,
      makeEdgarThatThrowsOnFetch(),
      makeStubResolver(),
    );
    expect(summary.ingestionLogId).toBe(1234);
  });

  it('zero-input run is a no-op (no errors, no parses)', async () => {
    const db = new StubDb();
    const summary = await runIngestion(
      {
        filerCIKs: [],
        targetPeriods: ['2025-12-31'],
        runKind: 'manual',
      },
      db,
      makeEdgarThatThrowsOnFetch(),
      makeStubResolver(),
    );
    expect(summary.filingsDiscovered).toBe(0);
    expect(summary.filingsParsed).toBe(0);
    expect(summary.parseErrors).toBe(0);
  });
});
