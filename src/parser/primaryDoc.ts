// Parser for 13F-HR primary_doc.xml — the cover page.
//
// Verified against three real filings in tests/fixtures/13f:
//   - Berkshire CIK 1067983, accession 0001193125-26-054580 (2025-12-31)
//   - Scion CIK 1649339, accession 0001649339-25-000007 (2025-09-30)
//   - Pershing Square CIK 1336528, accession 0001172661-26-001091 (2025-12-31)
//
// All three use schemaVersion X0202 with namespace
// http://www.sec.gov/edgar/thirteenffiler. Some filings include
// `summaryPage.otherManagers2Info` (Berkshire), some omit it (Scion, Pershing).

import { XMLParser } from 'fast-xml-parser';
import type { ParsedOtherManager, ParsedPrimaryDoc } from './types.js';

export class PrimaryDocParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrimaryDocParseError';
  }
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false, // keep everything as strings; we coerce explicitly
  trimValues: true,
});

/**
 * Parse a 13F-HR primary_doc.xml string. Throws PrimaryDocParseError on
 * malformed XML or missing required fields.
 */
export function parsePrimaryDoc(xml: string): ParsedPrimaryDoc {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (err) {
    throw new PrimaryDocParseError(`XML parse failed: ${(err as Error).message}`);
  }
  const root = pluck(parsed, 'edgarSubmission');
  if (!root) {
    throw new PrimaryDocParseError('missing <edgarSubmission> root');
  }

  const submissionType = requireString(
    pluck(root, 'headerData', 'submissionType'),
    'headerData.submissionType',
  );
  if (submissionType !== '13F-HR' && submissionType !== '13F-HR/A') {
    throw new PrimaryDocParseError(`unsupported submissionType: ${submissionType}`);
  }

  const cikRaw = requireString(
    pluck(root, 'headerData', 'filerInfo', 'filer', 'credentials', 'cik'),
    'headerData.filerInfo.filer.credentials.cik',
  );
  const filerCIK = padCikRaw(cikRaw);

  const periodOfReportMMDD = requireString(
    pluck(root, 'headerData', 'filerInfo', 'periodOfReport'),
    'headerData.filerInfo.periodOfReport',
  );
  const periodOfReport = mmddyyyyToISO(periodOfReportMMDD);

  const isAmendmentRaw = pluck(root, 'formData', 'coverPage', 'isAmendment');
  const isAmendmentFlag = parseBoolish(isAmendmentRaw);
  const isAmendment = submissionType === '13F-HR/A' || isAmendmentFlag === true;

  const filerName = requireString(
    pluck(root, 'formData', 'coverPage', 'filingManager', 'name'),
    'formData.coverPage.filingManager.name',
  );

  const reportType = stringOr(pluck(root, 'formData', 'coverPage', 'reportType'), '');
  const signatureDateRaw = stringOr(pluck(root, 'formData', 'signatureBlock', 'signatureDate'), '');
  const signatureDate = signatureDateRaw ? mmddyyyyToISO(signatureDateRaw) : null;

  const tableEntryTotal = requireInt(
    pluck(root, 'formData', 'summaryPage', 'tableEntryTotal'),
    'formData.summaryPage.tableEntryTotal',
  );
  const tableValueTotalRaw = requireInt(
    pluck(root, 'formData', 'summaryPage', 'tableValueTotal'),
    'formData.summaryPage.tableValueTotal',
  );

  const isConfidentialOmittedRaw = pluck(root, 'formData', 'summaryPage', 'isConfidentialOmitted');
  const isConfidentialOmitted = parseBoolish(isConfidentialOmittedRaw) === true;

  const otherIncludedManagers = parseOtherIncludedManagers(
    pluck(root, 'formData', 'summaryPage', 'otherManagers2Info'),
  );

  return {
    submissionType,
    isAmendment,
    filerCIK,
    periodOfReport,
    filerName,
    reportType,
    signatureDate,
    tableEntryTotal,
    tableValueTotalRaw,
    otherIncludedManagers,
    isConfidentialOmitted,
  };
}

function parseOtherIncludedManagers(node: unknown): ParsedOtherManager[] {
  if (!node || typeof node !== 'object') return [];
  const list = ensureArray(pluck(node, 'otherManager2'));
  return list.map((entry, idx) => {
    const sequenceRaw = coerceScalar(
      pluck(entry, 'sequenceNumber'),
      'otherManager2.sequenceNumber',
    );
    const sequenceNumber =
      sequenceRaw !== null && sequenceRaw.length > 0
        ? parseIntStrict(sequenceRaw, 'otherManager2.sequenceNumber')
        : idx + 1;
    const om = pluck(entry, 'otherManager');
    const name = stringOr(pluck(om, 'name'), '');
    const form13FFileNumber = stringOr(pluck(om, 'form13FFileNumber'), '');
    return {
      sequenceNumber,
      name,
      form13FFileNumber: form13FFileNumber || null,
    };
  });
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function pluck(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === 'object' && k in cur) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Coerce only primitive XML text values; throw on objects/arrays. */
function coerceScalar(v: unknown, path: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new PrimaryDocParseError(`expected scalar at ${path}, got ${typeof v}`);
}

function requireString(v: unknown, path: string): string {
  const s = coerceScalar(v, path);
  if (s === null || s.length === 0) {
    throw new PrimaryDocParseError(`missing field: ${path}`);
  }
  return s;
}

function stringOr(v: unknown, fallback: string): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'string') return v.trim().length > 0 ? v.trim() : fallback;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

function requireInt(v: unknown, path: string): number {
  const s = coerceScalar(v, path);
  if (s === null || s.length === 0) {
    throw new PrimaryDocParseError(`missing field: ${path}`);
  }
  return parseIntStrict(s, path);
}

function parseIntStrict(s: string, path: string): number {
  if (!/^-?\d+$/.test(s)) {
    throw new PrimaryDocParseError(`expected integer at ${path}: ${s}`);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n)) {
    throw new PrimaryDocParseError(`integer out of safe range at ${path}: ${s}`);
  }
  return n;
}

function parseBoolish(v: unknown): boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

function ensureArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function padCikRaw(s: string): string {
  const digits = s.replace(/\D/g, '');
  if (digits.length === 0) {
    throw new PrimaryDocParseError(`malformed CIK: ${s}`);
  }
  if (digits.length > 10) {
    throw new PrimaryDocParseError(`CIK too long: ${s}`);
  }
  return digits.padStart(10, '0');
}

function mmddyyyyToISO(s: string): string {
  // SEC writes "MM-DD-YYYY" — but some filers emit unpadded single-digit
  // month/day (e.g. "8-14-2025"). Accept either and zero-pad before
  // composing the ISO string.
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s.trim());
  if (!m) {
    throw new PrimaryDocParseError(`expected MM-DD-YYYY date, got ${s}`);
  }
  return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}
