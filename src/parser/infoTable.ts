// Parser for 13F-HR INFOTABLE XML — the holdings rows.
//
// Calibration 3 (locked in Phase 0): a single 13F can contain multiple
// <infoTable> rows with the same (cusip, putCall) — Berkshire's most-recent
// 13F has 3 ALLY FINL `02005N100` rows attributed to different
// <otherManager> codes. The parser MUST aggregate by (cusip, putCall) before
// any delta math or pctOfBook computation.
//
// Aggregation rules:
//   - shares: SUM
//   - value: SUM
//   - votingAuthority {sole, shared, none}: SUM each
//   - sshPrnamtType: must be uniform across the group; throws if mixed
//   - issuerName, titleOfClass: take first non-empty
//   - investmentDiscretion: take first non-null
//
// Class A vs Class B (different CUSIPs) NEVER aggregate — they live in
// separate buckets by construction.

import { XMLParser } from 'fast-xml-parser';
import type { AggregatedHolding, ParsedInfoTable, RawInfoTableRow } from './types.js';

export class InfoTableParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfoTableParseError';
  }
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

/**
 * Parse a 13F-HR InfoTable XML string. Returns both the raw rows (audit
 * trail) and the per-(cusip, putCall) aggregated holdings (the shape the
 * `holdings` Postgres table writes).
 */
export function parseInfoTable(xml: string): ParsedInfoTable {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (err) {
    throw new InfoTableParseError(`XML parse failed: ${(err as Error).message}`);
  }
  const root = (parsed as Record<string, unknown> | null)?.['informationTable'];
  if (!root) {
    throw new InfoTableParseError('missing <informationTable> root');
  }
  const rowsRaw = ensureArray((root as Record<string, unknown>)['infoTable']);
  const rawRows = rowsRaw.map((row, idx) => parseRow(row, idx));
  const aggregatedHoldings = aggregateByCusipPutCall(rawRows);
  return { rawRows, aggregatedHoldings };
}

function parseRow(row: unknown, idx: number): RawInfoTableRow {
  if (!row || typeof row !== 'object') {
    throw new InfoTableParseError(`infoTable[${idx}]: not an object`);
  }
  const o = row as Record<string, unknown>;
  const nameOfIssuer = requireString(o['nameOfIssuer'], `[${idx}].nameOfIssuer`);
  const titleOfClass = requireString(o['titleOfClass'], `[${idx}].titleOfClass`);
  const cusipRaw = requireString(o['cusip'], `[${idx}].cusip`);
  const cusip = normalizeCusip(cusipRaw, idx);
  const valueRaw = requireNumericString(o['value'], `[${idx}].value`);

  const sopa = (o['shrsOrPrnAmt'] ?? {}) as Record<string, unknown>;
  const sharesRaw = requireNumericString(sopa['sshPrnamt'], `[${idx}].shrsOrPrnAmt.sshPrnamt`);
  const sshPrnamtTypeRaw = requireString(
    sopa['sshPrnamtType'],
    `[${idx}].shrsOrPrnAmt.sshPrnamtType`,
  );
  if (sshPrnamtTypeRaw !== 'SH' && sshPrnamtTypeRaw !== 'PRN') {
    throw new InfoTableParseError(
      `[${idx}].sshPrnamtType: expected 'SH' or 'PRN', got '${sshPrnamtTypeRaw}'`,
    );
  }

  const putCallRaw = stringOrNull(o['putCall']);
  let putCall: 'Put' | 'Call' | null = null;
  if (putCallRaw !== null) {
    if (putCallRaw === 'Put' || putCallRaw === 'Call') {
      putCall = putCallRaw;
    } else {
      throw new InfoTableParseError(
        `[${idx}].putCall: expected 'Put'|'Call'|null, got '${putCallRaw}'`,
      );
    }
  }

  const investmentDiscretion = stringOrNull(o['investmentDiscretion']);
  const otherManager = stringOrNull(o['otherManager']);

  const va = (o['votingAuthority'] ?? {}) as Record<string, unknown>;
  const votingAuthority = {
    sole: parseAuthority(va['Sole'], `[${idx}].votingAuthority.Sole`),
    shared: parseAuthority(va['Shared'], `[${idx}].votingAuthority.Shared`),
    none: parseAuthority(va['None'], `[${idx}].votingAuthority.None`),
  };

  return {
    nameOfIssuer,
    titleOfClass,
    cusip,
    valueRaw,
    sharesRaw,
    sshPrnamtType: sshPrnamtTypeRaw,
    putCall,
    investmentDiscretion,
    otherManager,
    votingAuthority,
  };
}

function aggregateByCusipPutCall(rows: RawInfoTableRow[]): AggregatedHolding[] {
  const map = new Map<string, AggregatedHolding>();
  for (const row of rows) {
    const key = `${row.cusip}|${row.putCall ?? ''}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        cusip: row.cusip,
        putCall: row.putCall,
        nameOfIssuer: row.nameOfIssuer,
        titleOfClass: row.titleOfClass,
        shares: BigInt(row.sharesRaw),
        valueRaw: BigInt(row.valueRaw),
        sshPrnamtType: row.sshPrnamtType,
        investmentDiscretion: row.investmentDiscretion,
        votingAuthority: {
          sole: BigInt(row.votingAuthority.sole),
          shared: BigInt(row.votingAuthority.shared),
          none: BigInt(row.votingAuthority.none),
        },
        sourceRowCount: 1,
      });
      continue;
    }
    if (existing.sshPrnamtType !== row.sshPrnamtType) {
      throw new InfoTableParseError(
        `aggregation conflict for cusip=${row.cusip} putCall=${row.putCall ?? 'null'}: ` +
          `sshPrnamtType differs ('${existing.sshPrnamtType}' vs '${row.sshPrnamtType}')`,
      );
    }
    existing.shares += BigInt(row.sharesRaw);
    existing.valueRaw += BigInt(row.valueRaw);
    existing.votingAuthority.sole += BigInt(row.votingAuthority.sole);
    existing.votingAuthority.shared += BigInt(row.votingAuthority.shared);
    existing.votingAuthority.none += BigInt(row.votingAuthority.none);
    if (!existing.investmentDiscretion && row.investmentDiscretion) {
      existing.investmentDiscretion = row.investmentDiscretion;
    }
    if (!existing.nameOfIssuer && row.nameOfIssuer) {
      existing.nameOfIssuer = row.nameOfIssuer;
    }
    if (!existing.titleOfClass && row.titleOfClass) {
      existing.titleOfClass = row.titleOfClass;
    }
    existing.sourceRowCount += 1;
  }
  return Array.from(map.values());
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function ensureArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function coerceScalar(v: unknown, path: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new InfoTableParseError(`expected scalar at ${path}, got ${typeof v}`);
}

function requireString(v: unknown, path: string): string {
  const s = coerceScalar(v, path);
  if (s === null || s.length === 0) {
    throw new InfoTableParseError(`missing field: ${path}`);
  }
  return s;
}

function stringOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function requireNumericString(v: unknown, path: string): string {
  const s = coerceScalar(v, path);
  if (s === null || s.length === 0) {
    throw new InfoTableParseError(`missing field: ${path}`);
  }
  if (!/^\d+$/.test(s)) {
    throw new InfoTableParseError(`expected non-negative integer at ${path}: '${s}'`);
  }
  return s;
}

function parseAuthority(v: unknown, path: string): bigint {
  const s = coerceScalar(v, path);
  if (s === null || s.length === 0) return 0n;
  if (!/^\d+$/.test(s)) {
    throw new InfoTableParseError(`expected non-negative integer at ${path}: '${s}'`);
  }
  return BigInt(s);
}

function normalizeCusip(raw: string, idx: number): string {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[0-9A-Z]{9}$/.test(s)) {
    throw new InfoTableParseError(`[${idx}].cusip: expected 9 alphanumeric chars, got '${raw}'`);
  }
  return s;
}
