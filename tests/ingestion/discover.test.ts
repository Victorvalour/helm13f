// Discovery tests + recentQuarterEnds() boundary cases.

import { describe, it, expect } from 'vitest';
import { discoverFilingsForFiler, recentQuarterEnds } from '../../src/ingestion/index.js';
import type { EdgarClient, EdgarSubmissions } from '../../src/sources/edgar/index.js';

function makeStubEdgar(subs: EdgarSubmissions): EdgarClient {
  return {
    getSubmissions: () => Promise.resolve(subs),
    getSubmissionsPage: () =>
      Promise.resolve({
        accessionNumber: [],
        filingDate: [],
        form: [],
        primaryDocument: [],
      }),
    getFilingIndex: () => Promise.reject(new Error('not used')),
    getFilingFile: () => Promise.reject(new Error('not used')),
    getCompanyTickers: () => Promise.reject(new Error('not used')),
    fullTextSearch: () => Promise.reject(new Error('not used')),
  } as unknown as EdgarClient;
}

const SAMPLE_SUBS: EdgarSubmissions = {
  cik: '0001067983',
  name: 'BERKSHIRE HATHAWAY INC',
  filings: {
    recent: {
      accessionNumber: [
        '0001193125-26-054580',
        '0001193125-25-282901',
        '0000950123-25-008361',
        '0000950123-25-008343',
        '0001193125-26-001000',
      ],
      filingDate: ['2026-02-17', '2025-11-14', '2025-08-14', '2025-08-14', '2026-01-15'],
      form: [
        '13F-HR',
        '13F-HR',
        '13F-HR/A',
        '13F-HR',
        '8-K', // not 13F — must be filtered out
      ],
      primaryDocument: [
        'primary_doc.xml',
        'primary_doc.xml',
        'primary_doc.xml',
        'primary_doc.xml',
        '8k.htm',
      ],
      periodOfReport: ['2025-12-31', '2025-09-30', '2025-06-30', '2025-06-30', '2026-01-15'],
    },
    files: [],
  },
};

describe('discoverFilingsForFiler', () => {
  it('filters to 13F-HR / 13F-HR/A only and to target periods', async () => {
    const edgar = makeStubEdgar(SAMPLE_SUBS);
    const out = await discoverFilingsForFiler(
      edgar,
      '0001067983',
      new Set(['2025-12-31', '2025-09-30']),
    );
    expect(out).toHaveLength(2);
    expect(out.map((d) => d.accessionNumber)).toEqual([
      '0001193125-25-282901', // 2025-11-14
      '0001193125-26-054580', // 2026-02-17 (later, sorts last)
    ]);
    for (const d of out) expect(['13F-HR', '13F-HR/A']).toContain(d.form);
  });

  it('marks 13F-HR/A as isAmendment=true', async () => {
    const edgar = makeStubEdgar(SAMPLE_SUBS);
    const out = await discoverFilingsForFiler(edgar, '0001067983', new Set(['2025-06-30']));
    expect(out).toHaveLength(2);
    const amended = out.find((d) => d.form === '13F-HR/A');
    expect(amended?.isAmendment).toBe(true);
    const original = out.find((d) => d.form === '13F-HR');
    expect(original?.isAmendment).toBe(false);
  });

  it('returns empty when no target period matches', async () => {
    const edgar = makeStubEdgar(SAMPLE_SUBS);
    const out = await discoverFilingsForFiler(edgar, '0001067983', new Set(['2024-12-31']));
    expect(out).toEqual([]);
  });

  it('passes through filer name onto every discovered filing', async () => {
    const edgar = makeStubEdgar(SAMPLE_SUBS);
    const out = await discoverFilingsForFiler(edgar, '0001067983', new Set(['2025-12-31']));
    expect(out[0]?.filerName).toBe('BERKSHIRE HATHAWAY INC');
  });

  // Regression: pre-2002 paper 13F filings have null periodOfReport in EDGAR's
  // submissions JSON. They must be skipped — they're outside any quarter window
  // and don't have the primary_doc.xml the parser expects.
  it('skips filings with null periodOfReport', async () => {
    const subs: EdgarSubmissions = {
      cik: '0001067983',
      name: 'BERKSHIRE HATHAWAY INC',
      filings: {
        recent: {
          accessionNumber: ['0000950148-99-001187', '0001193125-25-282901'],
          filingDate: ['1999-08-15', '2025-11-14'],
          form: ['13F-HR', '13F-HR'],
          primaryDocument: ['', 'primary_doc.xml'],
          periodOfReport: ['', '2025-09-30'],
        },
        files: [],
      },
    };
    const edgar = makeStubEdgar(subs);
    const out = await discoverFilingsForFiler(edgar, '0001067983', new Set(['2025-09-30']));
    expect(out).toHaveLength(1);
    expect(out[0]?.accessionNumber).toBe('0001193125-25-282901');
  });
});

describe('recentQuarterEnds', () => {
  it('returns the most recent N quarter-ends descending from today', () => {
    // Today: 2026-05-04 → most recent completed quarter-end is 2026-03-31.
    const out = recentQuarterEnds(new Date('2026-05-04T00:00:00Z'), 4);
    expect(out).toEqual(['2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30']);
  });

  it('handles year-rollback', () => {
    // 2026-02-15 is between Jan 1 and Mar 31 → most recent quarter-end
    // is 2025-12-31.
    const out = recentQuarterEnds(new Date('2026-02-15T00:00:00Z'), 3);
    expect(out).toEqual(['2025-12-31', '2025-09-30', '2025-06-30']);
  });

  it('returns exactly n entries', () => {
    expect(recentQuarterEnds(new Date('2026-05-04T00:00:00Z'), 8)).toHaveLength(8);
  });
});
