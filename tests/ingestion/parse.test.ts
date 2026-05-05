// fetchAndParseFiling tests against real fixture XML.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAndParseFiling, FilingFetchError } from '../../src/ingestion/index.js';
import type { EdgarClient, EdgarFilingIndex } from '../../src/sources/edgar/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, '..', 'fixtures', '13f');

function readFixture(slug: string, file: string): string {
  return readFileSync(join(FIX, slug, file), 'utf8');
}

function readJsonFixture(slug: string, file: string): EdgarFilingIndex {
  return JSON.parse(readFileSync(join(FIX, slug, file), 'utf8')) as EdgarFilingIndex;
}

interface FetchCalls {
  files: string[];
  indexes: string[];
}

function makeStubEdgar(slug: string): { edgar: EdgarClient; calls: FetchCalls } {
  const calls: FetchCalls = { files: [], indexes: [] };
  const edgar = {
    getFilingFile: (_cik: string | number, _accession: string, filename: string) => {
      calls.files.push(filename);
      const file = filename === 'primary_doc.xml' ? 'primary_doc.xml' : 'infotable.xml';
      return Promise.resolve(readFixture(slug, file));
    },
    getFilingIndex: (_cik: string | number, accession: string) => {
      calls.indexes.push(accession);
      return Promise.resolve(readJsonFixture(slug, 'index.json'));
    },
    getSubmissions: () => Promise.reject(new Error('not used')),
    getSubmissionsPage: () => Promise.reject(new Error('not used')),
    getCompanyTickers: () => Promise.reject(new Error('not used')),
    fullTextSearch: () => Promise.reject(new Error('not used')),
  } as unknown as EdgarClient;
  return { edgar, calls };
}

describe('fetchAndParseFiling — Berkshire 0001193125-26-054580', () => {
  it('orchestrates index → primary_doc → InfoTable end-to-end', async () => {
    const { edgar, calls } = makeStubEdgar('berkshire-0001193125-26-054580');
    const out = await fetchAndParseFiling(
      edgar,
      '0001067983',
      '0001193125-26-054580',
      '2026-02-17',
    );
    expect(out.primaryDoc.filerCIK).toBe('0001067983');
    expect(out.primaryDoc.periodOfReport).toBe('2025-12-31');
    expect(out.primaryDoc.tableEntryTotal).toBe(110);
    expect(out.holdings).toHaveLength(42); // post-aggregation
    expect(out.bookValueUSD).toBe(274_160_086_701n);
    expect(out.valueScale).toBe('USD'); // filed 2026-02-17, post-2023-Q3

    // URL construction.
    expect(out.primaryDocURL).toBe(
      'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/primary_doc.xml',
    );
    expect(out.infoTableURL).toBe(
      'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml',
    );
    expect(out.infoTableFilename).toBe('50240.xml');

    // Call ordering: primary_doc.xml → index.json → InfoTable.xml.
    expect(calls.files[0]).toBe('primary_doc.xml');
    expect(calls.indexes).toHaveLength(1);
    expect(calls.files[1]).toBe('50240.xml');
  });

  it('honours valueScale=USD_THOUSANDS for pre-2023-Q3 filing dates', async () => {
    const { edgar } = makeStubEdgar('berkshire-0001193125-26-054580');
    const out = await fetchAndParseFiling(
      edgar,
      '0001067983',
      '0001193125-26-054580',
      '2023-05-15', // pre-2023-Q3
    );
    expect(out.valueScale).toBe('USD_THOUSANDS');
    // bookValue is multiplied by 1000.
    expect(out.bookValueUSD).toBe(274_160_086_701_000n);
  });
});

describe('fetchAndParseFiling — Scion + Pershing fixtures', () => {
  it('Scion: 8 holdings, periodOfReport 2025-09-30', async () => {
    const { edgar } = makeStubEdgar('scion-0001649339-25-000007');
    const out = await fetchAndParseFiling(
      edgar,
      '0001649339',
      '0001649339-25-000007',
      '2025-11-14',
    );
    expect(out.primaryDoc.periodOfReport).toBe('2025-09-30');
    expect(out.holdings).toHaveLength(8);
    expect(out.bookValueUSD).toBe(1_381_198_076n);
  });

  it('Pershing Square: 11 holdings, periodOfReport 2025-12-31', async () => {
    const { edgar } = makeStubEdgar('pershing-0001172661-26-001091');
    const out = await fetchAndParseFiling(
      edgar,
      '0001336528',
      '0001172661-26-001091',
      '2026-02-17',
    );
    expect(out.primaryDoc.periodOfReport).toBe('2025-12-31');
    expect(out.holdings).toHaveLength(11);
    expect(out.bookValueUSD).toBe(15_526_737_802n);
  });
});

describe('fetchAndParseFiling — error path', () => {
  it('throws FilingFetchError when no InfoTable XML exists in the directory', async () => {
    // Reuse Berkshire's primary_doc.xml so primaryDoc parsing succeeds; the
    // FilingFetchError must come from pickInfoTableFilename returning null.
    const validPrimary = readFixture('berkshire-0001193125-26-054580', 'primary_doc.xml');
    const edgar = {
      getFilingFile: () => Promise.resolve(validPrimary),
      getFilingIndex: () =>
        Promise.resolve({
          directory: {
            name: 'x',
            'parent-dir': 'y',
            item: [
              {
                name: 'primary_doc.xml',
                type: 'xml',
                'last-modified': '',
                size: '0',
              },
            ],
          },
        }),
    } as unknown as EdgarClient;
    await expect(
      fetchAndParseFiling(edgar, '0001067983', '0001193125-26-054580', '2026-02-17'),
    ).rejects.toBeInstanceOf(FilingFetchError);
  });
});
