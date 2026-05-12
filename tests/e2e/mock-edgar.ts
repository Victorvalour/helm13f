// Fixture-backed EdgarClient stand-in for e2e tests. Returns canned
// XML/JSON from tests/fixtures/13f/* so ingestion runs deterministically
// without hitting SEC.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EdgarClient,
  EdgarFilingIndex,
  EdgarSubmissions,
  EdgarSubmissionsPage,
} from '../../src/sources/edgar/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, '..', 'fixtures', '13f');

interface FilerFixture {
  cik: string;
  name: string;
  slug: string;
  accession: string;
  filingDate: string;
  periodOfReport: string;
}

const FIXTURES: FilerFixture[] = [
  {
    cik: '0001067983',
    name: 'BERKSHIRE HATHAWAY INC',
    slug: 'berkshire-0001193125-26-054580',
    accession: '0001193125-26-054580',
    filingDate: '2026-02-17',
    periodOfReport: '2025-12-31',
  },
  {
    cik: '0001649339',
    name: 'SCION ASSET MANAGEMENT, LLC',
    slug: 'scion-0001649339-25-000007',
    accession: '0001649339-25-000007',
    filingDate: '2025-11-14',
    periodOfReport: '2025-09-30',
  },
  {
    cik: '0001336528',
    name: 'Pershing Square Capital Management, L.P.',
    slug: 'pershing-0001172661-26-001091',
    accession: '0001172661-26-001091',
    filingDate: '2026-02-17',
    periodOfReport: '2025-12-31',
  },
];

const BY_CIK = new Map(FIXTURES.map((f) => [f.cik, f]));
const BY_ACCESSION = new Map(FIXTURES.map((f) => [f.accession, f]));

/** Build a stub EdgarClient backed by the three real fixtures. */
export function makeFixtureEdgar(): EdgarClient {
  const stub = {
    getSubmissions: (cik: string | number): Promise<EdgarSubmissions> => {
      const padded =
        typeof cik === 'number' ? String(cik).padStart(10, '0') : cik.padStart(10, '0');
      const f = BY_CIK.get(padded);
      if (!f) {
        return Promise.reject(new Error(`no fixture for cik ${padded}`));
      }
      return Promise.resolve({
        cik: f.cik,
        name: f.name,
        filings: {
          recent: {
            accessionNumber: [f.accession],
            filingDate: [f.filingDate],
            form: ['13F-HR'],
            primaryDocument: ['xslForm13F_X02/primary_doc.xml'],
            periodOfReport: [f.periodOfReport],
          },
          files: [],
        },
      });
    },

    getSubmissionsPage: (_filename: string): Promise<EdgarSubmissionsPage> =>
      Promise.resolve({
        accessionNumber: [],
        filingDate: [],
        form: [],
        primaryDocument: [],
      }),

    getFilingIndex: (_cik: string | number, accession: string): Promise<EdgarFilingIndex> => {
      const f = BY_ACCESSION.get(accession);
      if (!f) return Promise.reject(new Error(`no fixture for ${accession}`));
      const indexJson = readFileSync(join(FIX, f.slug, 'index.json'), 'utf8');
      return Promise.resolve(JSON.parse(indexJson) as EdgarFilingIndex);
    },

    getFilingFile: (
      _cik: string | number,
      accession: string,
      filename: string,
    ): Promise<string> => {
      const f = BY_ACCESSION.get(accession);
      if (!f) return Promise.reject(new Error(`no fixture for ${accession}`));
      const file = filename === 'primary_doc.xml' ? 'primary_doc.xml' : 'infotable.xml';
      return Promise.resolve(readFileSync(join(FIX, f.slug, file), 'utf8'));
    },

    getCompanyTickers: () => Promise.reject(new Error('not used in e2e')),
    fullTextSearch: () => Promise.reject(new Error('not used in e2e')),
  };
  return stub as unknown as EdgarClient;
}

export const FIXTURE_FILERS = FIXTURES;
