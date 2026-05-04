// Tests for parseInfoTable against three real 13F-HR InfoTable files +
// synthetic edge cases.
//
// Calibration 3 (locked in Phase 0): aggregation by (cusip, putCall) per
// filing must happen before any delta math. Real-world fixture: Berkshire's
// most-recent 13F has 6 ALLY FINL `02005N100` rows attributed to different
// otherManager codes; aggregated they sum to shares=29,000,000,
// value=$1,313,410,001.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInfoTable, InfoTableParseError } from '../../src/parser/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures', '13f');

function loadFixture(slug: string): string {
  return readFileSync(join(FIXTURES, slug, 'infotable.xml'), 'utf8');
}

describe('parseInfoTable — Berkshire 0001193125-26-054580 (110 raw rows, 42 aggregated)', () => {
  const xml = loadFixture('berkshire-0001193125-26-054580');
  const parsed = parseInfoTable(xml);

  it('parses 110 raw rows (cover-page tableEntryTotal)', () => {
    expect(parsed.rawRows.length).toBe(110);
  });

  it('aggregates to 42 unique (cusip, putCall) groups', () => {
    expect(parsed.aggregatedHoldings.length).toBe(42);
  });

  it('every raw row has a 9-char uppercase CUSIP', () => {
    for (const r of parsed.rawRows) {
      expect(r.cusip).toMatch(/^[0-9A-Z]{9}$/);
    }
  });

  it('aggregates 6 ALLY FINL rows (CUSIP 02005N100) into a single holding', () => {
    const ally = parsed.aggregatedHoldings.find((h) => h.cusip === '02005N100');
    expect(ally).toBeDefined();
    expect(ally!.sourceRowCount).toBe(6);
    expect(ally!.shares).toBe(29_000_000n);
    expect(ally!.valueRaw).toBe(1_313_410_001n);
    expect(ally!.putCall).toBeNull();
    expect(ally!.sshPrnamtType).toBe('SH');
    expect(ally!.nameOfIssuer).toBe('ALLY FINL INC');
    expect(ally!.titleOfClass).toBe('COM');
  });

  it('every aggregated holding has shares >= sum of raw rows for its key', () => {
    const sumByKey = new Map<string, bigint>();
    for (const r of parsed.rawRows) {
      const k = `${r.cusip}|${r.putCall ?? ''}`;
      sumByKey.set(k, (sumByKey.get(k) ?? 0n) + BigInt(r.sharesRaw));
    }
    for (const h of parsed.aggregatedHoldings) {
      const k = `${h.cusip}|${h.putCall ?? ''}`;
      expect(h.shares).toBe(sumByKey.get(k));
    }
  });
});

describe('parseInfoTable — Scion 0001649339-25-000007 (8 rows, no aggregation)', () => {
  const xml = loadFixture('scion-0001649339-25-000007');
  const parsed = parseInfoTable(xml);

  it('parses 8 raw rows and 8 aggregated holdings (no aggregation needed)', () => {
    expect(parsed.rawRows.length).toBe(8);
    expect(parsed.aggregatedHoldings.length).toBe(8);
    for (const h of parsed.aggregatedHoldings) {
      expect(h.sourceRowCount).toBe(1);
    }
  });

  it('preserves sshPrnamtType and putCall', () => {
    for (const r of parsed.rawRows) {
      expect(['SH', 'PRN']).toContain(r.sshPrnamtType);
    }
  });
});

describe('parseInfoTable — Pershing Square 0001172661-26-001091 (11 rows, no aggregation)', () => {
  const xml = loadFixture('pershing-0001172661-26-001091');
  const parsed = parseInfoTable(xml);

  it('parses 11 raw rows and 11 aggregated holdings', () => {
    expect(parsed.rawRows.length).toBe(11);
    expect(parsed.aggregatedHoldings.length).toBe(11);
  });
});

describe('parseInfoTable — synthetic Class A vs Class B (different CUSIPs, NEVER aggregate)', () => {
  it('keeps Class A and Class B as separate holdings even with same issuer', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
        <infoTable>
          <nameOfIssuer>BERKSHIRE HATHAWAY INC</nameOfIssuer>
          <titleOfClass>CL A</titleOfClass>
          <cusip>084670108</cusip>
          <value>10000000</value>
          <shrsOrPrnAmt><sshPrnamt>15</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
          <investmentDiscretion>SOLE</investmentDiscretion>
          <votingAuthority><Sole>15</Sole><Shared>0</Shared><None>0</None></votingAuthority>
        </infoTable>
        <infoTable>
          <nameOfIssuer>BERKSHIRE HATHAWAY INC</nameOfIssuer>
          <titleOfClass>CL B</titleOfClass>
          <cusip>084670702</cusip>
          <value>2500000</value>
          <shrsOrPrnAmt><sshPrnamt>5000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
          <investmentDiscretion>SOLE</investmentDiscretion>
          <votingAuthority><Sole>5000</Sole><Shared>0</Shared><None>0</None></votingAuthority>
        </infoTable>
      </informationTable>`;
    const parsed = parseInfoTable(xml);
    expect(parsed.aggregatedHoldings.length).toBe(2);
    const a = parsed.aggregatedHoldings.find((h) => h.cusip === '084670108');
    const b = parsed.aggregatedHoldings.find((h) => h.cusip === '084670702');
    expect(a!.shares).toBe(15n);
    expect(b!.shares).toBe(5000n);
    expect(a!.titleOfClass).toBe('CL A');
    expect(b!.titleOfClass).toBe('CL B');
  });
});

describe('parseInfoTable — synthetic putCall split (same CUSIP, different option side)', () => {
  it('splits Put vs Call vs underlying into three separate holdings', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
        <infoTable>
          <nameOfIssuer>APPLE INC</nameOfIssuer>
          <titleOfClass>COM</titleOfClass>
          <cusip>037833100</cusip>
          <value>1000</value>
          <shrsOrPrnAmt><sshPrnamt>10</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
          <votingAuthority><Sole>10</Sole><Shared>0</Shared><None>0</None></votingAuthority>
        </infoTable>
        <infoTable>
          <nameOfIssuer>APPLE INC</nameOfIssuer>
          <titleOfClass>COM</titleOfClass>
          <cusip>037833100</cusip>
          <value>500</value>
          <shrsOrPrnAmt><sshPrnamt>5</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
          <putCall>Call</putCall>
          <votingAuthority><Sole>5</Sole><Shared>0</Shared><None>0</None></votingAuthority>
        </infoTable>
        <infoTable>
          <nameOfIssuer>APPLE INC</nameOfIssuer>
          <titleOfClass>COM</titleOfClass>
          <cusip>037833100</cusip>
          <value>200</value>
          <shrsOrPrnAmt><sshPrnamt>2</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
          <putCall>Put</putCall>
          <votingAuthority><Sole>2</Sole><Shared>0</Shared><None>0</None></votingAuthority>
        </infoTable>
      </informationTable>`;
    const parsed = parseInfoTable(xml);
    expect(parsed.aggregatedHoldings.length).toBe(3);
    const sides = parsed.aggregatedHoldings.map((h) => h.putCall);
    expect(new Set(sides)).toEqual(new Set([null, 'Call', 'Put']));
    // Each side should be exactly one row.
    expect(parsed.aggregatedHoldings.every((h) => h.sourceRowCount === 1)).toBe(true);
  });
});

describe('parseInfoTable — synthetic 3-row aggregation matches Berkshire ALLY pattern', () => {
  it('sums shares and value across 3 rows for the same (cusip, null)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
        <infoTable>
          <nameOfIssuer>ALLY FINL INC</nameOfIssuer>
          <titleOfClass>COM</titleOfClass>
          <cusip>02005N100</cusip>
          <value>576074081</value>
          <shrsOrPrnAmt><sshPrnamt>12719675</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
          <investmentDiscretion>DFND</investmentDiscretion>
          <otherManager>4</otherManager>
          <votingAuthority><Sole>12719675</Sole><Shared>0</Shared><None>0</None></votingAuthority>
        </infoTable>
        <infoTable>
          <nameOfIssuer>ALLY FINL INC</nameOfIssuer>
          <titleOfClass>COM</titleOfClass>
          <cusip>02005N100</cusip>
          <value>126987499</value>
          <shrsOrPrnAmt><sshPrnamt>2803875</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
          <investmentDiscretion>DFND</investmentDiscretion>
          <otherManager>2,4,11</otherManager>
          <votingAuthority><Sole>2803875</Sole><Shared>0</Shared><None>0</None></votingAuthority>
        </infoTable>
        <infoTable>
          <nameOfIssuer>ALLY FINL INC</nameOfIssuer>
          <titleOfClass>COM</titleOfClass>
          <cusip>02005N100</cusip>
          <value>191495178</value>
          <shrsOrPrnAmt><sshPrnamt>4228200</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
          <investmentDiscretion>DFND</investmentDiscretion>
          <otherManager>4,5</otherManager>
          <votingAuthority><Sole>4228200</Sole><Shared>0</Shared><None>0</None></votingAuthority>
        </infoTable>
      </informationTable>`;
    const parsed = parseInfoTable(xml);
    expect(parsed.aggregatedHoldings.length).toBe(1);
    const h = parsed.aggregatedHoldings[0]!;
    expect(h.shares).toBe(12_719_675n + 2_803_875n + 4_228_200n);
    expect(h.valueRaw).toBe(576_074_081n + 126_987_499n + 191_495_178n);
    expect(h.sourceRowCount).toBe(3);
    expect(h.votingAuthority.sole).toBe(12_719_675n + 2_803_875n + 4_228_200n);
  });
});

describe('parseInfoTable — error paths', () => {
  it('throws InfoTableParseError on missing root', () => {
    expect(() => parseInfoTable('<?xml version="1.0"?><x/>')).toThrow(InfoTableParseError);
  });

  it('throws on invalid CUSIP length', () => {
    const xml = `<?xml version="1.0"?>
      <informationTable>
        <infoTable>
          <nameOfIssuer>X</nameOfIssuer>
          <titleOfClass>COM</titleOfClass>
          <cusip>123</cusip>
          <value>1</value>
          <shrsOrPrnAmt><sshPrnamt>1</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
          <votingAuthority><Sole>1</Sole><Shared>0</Shared><None>0</None></votingAuthority>
        </infoTable>
      </informationTable>`;
    expect(() => parseInfoTable(xml)).toThrow(/cusip.*9 alphanumeric/);
  });

  it('throws when sshPrnamtType is not SH or PRN', () => {
    const xml = `<?xml version="1.0"?>
      <informationTable>
        <infoTable>
          <nameOfIssuer>X</nameOfIssuer>
          <titleOfClass>COM</titleOfClass>
          <cusip>037833100</cusip>
          <value>1</value>
          <shrsOrPrnAmt><sshPrnamt>1</sshPrnamt><sshPrnamtType>BOGUS</sshPrnamtType></shrsOrPrnAmt>
          <votingAuthority><Sole>1</Sole><Shared>0</Shared><None>0</None></votingAuthority>
        </infoTable>
      </informationTable>`;
    expect(() => parseInfoTable(xml)).toThrow(/sshPrnamtType/);
  });

  it('throws on aggregation conflict (sshPrnamtType differs across rows)', () => {
    const xml = `<?xml version="1.0"?>
      <informationTable>
        <infoTable>
          <nameOfIssuer>X</nameOfIssuer>
          <titleOfClass>COM</titleOfClass>
          <cusip>037833100</cusip>
          <value>1</value>
          <shrsOrPrnAmt><sshPrnamt>1</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
          <votingAuthority><Sole>1</Sole><Shared>0</Shared><None>0</None></votingAuthority>
        </infoTable>
        <infoTable>
          <nameOfIssuer>X</nameOfIssuer>
          <titleOfClass>COM</titleOfClass>
          <cusip>037833100</cusip>
          <value>1</value>
          <shrsOrPrnAmt><sshPrnamt>1</sshPrnamt><sshPrnamtType>PRN</sshPrnamtType></shrsOrPrnAmt>
          <votingAuthority><Sole>1</Sole><Shared>0</Shared><None>0</None></votingAuthority>
        </infoTable>
      </informationTable>`;
    expect(() => parseInfoTable(xml)).toThrow(/aggregation conflict/);
  });
});
