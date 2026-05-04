// Tests for parsePrimaryDoc against three real 13F-HR cover pages.
//
// Fixtures: tests/fixtures/13f/{berkshire,scion,pershing}-{accession}/primary_doc.xml

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePrimaryDoc, PrimaryDocParseError } from '../../src/parser/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures', '13f');

function loadFixture(slug: string): string {
  return readFileSync(join(FIXTURES, slug, 'primary_doc.xml'), 'utf8');
}

describe('parsePrimaryDoc — Berkshire CIK 1067983, accession 0001193125-26-054580', () => {
  const xml = loadFixture('berkshire-0001193125-26-054580');
  const parsed = parsePrimaryDoc(xml);

  it('parses submission type and amendment flag', () => {
    expect(parsed.submissionType).toBe('13F-HR');
    expect(parsed.isAmendment).toBe(false);
  });

  it('parses the 10-digit padded CIK', () => {
    expect(parsed.filerCIK).toBe('0001067983');
  });

  it('converts MM-DD-YYYY periodOfReport to ISO YYYY-MM-DD', () => {
    expect(parsed.periodOfReport).toBe('2025-12-31');
  });

  it('parses the filing manager name from coverPage', () => {
    expect(parsed.filerName).toBe('Berkshire Hathaway Inc');
  });

  it('parses cover-page totals', () => {
    expect(parsed.tableEntryTotal).toBe(110);
    expect(parsed.tableValueTotalRaw).toBe(274_160_086_701);
  });

  it('parses signatureDate to ISO', () => {
    expect(parsed.signatureDate).toBe('2026-02-13');
  });

  it('parses other included managers', () => {
    expect(parsed.otherIncludedManagers.length).toBeGreaterThan(0);
    const buffett = parsed.otherIncludedManagers.find((m) => m.name === 'Buffett Warren E');
    expect(buffett).toBeDefined();
    expect(buffett!.form13FFileNumber).toBe('28-554');
  });

  it('isConfidentialOmitted is false', () => {
    expect(parsed.isConfidentialOmitted).toBe(false);
  });
});

describe('parsePrimaryDoc — Scion CIK 1649339, accession 0001649339-25-000007', () => {
  const xml = loadFixture('scion-0001649339-25-000007');
  const parsed = parsePrimaryDoc(xml);

  it('parses Scion identifiers', () => {
    expect(parsed.filerCIK).toBe('0001649339');
    expect(parsed.filerName).toBe('Scion Asset Management, LLC');
    expect(parsed.periodOfReport).toBe('2025-09-30');
  });

  it('parses Scion totals', () => {
    expect(parsed.tableEntryTotal).toBe(8);
    expect(parsed.tableValueTotalRaw).toBe(1_381_198_076);
  });

  it('parses Scion otherIncludedManagers (2 sub-managers)', () => {
    expect(parsed.otherIncludedManagers).toHaveLength(2);
    expect(parsed.otherIncludedManagers.map((m) => m.name)).toContain('SCION CAPITAL GROUP, LLC');
    for (const m of parsed.otherIncludedManagers) {
      expect(m.sequenceNumber).toBeGreaterThan(0);
    }
  });
});

describe('parsePrimaryDoc — Pershing Square CIK 1336528, accession 0001172661-26-001091', () => {
  const xml = loadFixture('pershing-0001172661-26-001091');
  const parsed = parsePrimaryDoc(xml);

  it('parses Pershing Square identifiers', () => {
    expect(parsed.filerCIK).toBe('0001336528');
    expect(parsed.filerName).toBe('Pershing Square Capital Management, L.P.');
    expect(parsed.periodOfReport).toBe('2025-12-31');
  });

  it('parses Pershing totals', () => {
    expect(parsed.tableEntryTotal).toBe(11);
    expect(parsed.tableValueTotalRaw).toBe(15_526_737_802);
  });

  it('Pershing has no otherIncludedManagers', () => {
    expect(parsed.otherIncludedManagers).toEqual([]);
  });
});

describe('parsePrimaryDoc — error paths', () => {
  it('throws on malformed XML', () => {
    expect(() => parsePrimaryDoc('<not really xml')).toThrow(PrimaryDocParseError);
  });

  it('throws on missing required field', () => {
    const xml = `<?xml version="1.0"?><edgarSubmission><headerData></headerData></edgarSubmission>`;
    expect(() => parsePrimaryDoc(xml)).toThrow(/submissionType/);
  });

  it('throws on unsupported submissionType', () => {
    const xml = `<?xml version="1.0"?>
      <edgarSubmission>
        <headerData>
          <submissionType>13F-NT</submissionType>
        </headerData>
      </edgarSubmission>`;
    expect(() => parsePrimaryDoc(xml)).toThrow(/unsupported submissionType/);
  });

  it('treats submissionType=13F-HR/A as isAmendment=true', () => {
    const xml = `<?xml version="1.0"?>
      <edgarSubmission>
        <headerData>
          <submissionType>13F-HR/A</submissionType>
          <filerInfo>
            <filer><credentials><cik>0001067983</cik></credentials></filer>
            <periodOfReport>12-31-2025</periodOfReport>
          </filerInfo>
        </headerData>
        <formData>
          <coverPage>
            <isAmendment>true</isAmendment>
            <filingManager><name>X</name></filingManager>
            <reportType>13F HOLDINGS REPORT</reportType>
          </coverPage>
          <summaryPage>
            <tableEntryTotal>0</tableEntryTotal>
            <tableValueTotal>0</tableValueTotal>
          </summaryPage>
        </formData>
      </edgarSubmission>`;
    const parsed = parsePrimaryDoc(xml);
    expect(parsed.submissionType).toBe('13F-HR/A');
    expect(parsed.isAmendment).toBe(true);
  });
});
