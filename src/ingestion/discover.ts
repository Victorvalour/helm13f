// Discover 13F-HR / 13F-HR/A filings to ingest for a given filer CIK.
//
// Reads /submissions/CIK{padded}.json's recent[] block and returns the
// subset whose periodOfReport is in `targetPeriods` (caller supplies).
// Older history pages (filings.files[]) are followed only when the
// caller asks for periods that aren't in the recent[] window.

import type { EdgarClient, EdgarSubmissions } from '../sources/edgar/index.js';

export interface DiscoveredFiling {
  filerCIK: string;
  filerName: string;
  accessionNumber: string;
  form: '13F-HR' | '13F-HR/A';
  isAmendment: boolean;
  filingDate: string; // ISO YYYY-MM-DD
  periodOfReport: string | null; // ISO YYYY-MM-DD, may be null in submissions
  primaryDocument: string;
}

/**
 * Filter the recent[] submissions for a filer to the target periods.
 * Returns ordered by filingDate ASC so amendments (later filings)
 * naturally apply on top of the original.
 */
export async function discoverFilingsForFiler(
  edgar: EdgarClient,
  filerCIK: string,
  targetPeriods: ReadonlySet<string>,
): Promise<DiscoveredFiling[]> {
  const subs = await edgar.getSubmissions(filerCIK);
  const out = collectFromSubmissions(subs, filerCIK, targetPeriods);

  // If we asked for periods not covered by recent[] (which holds ~1000
  // filings), follow the filings.files[] pages.
  const missingPeriods = computeMissingPeriods(out, targetPeriods);
  if (missingPeriods.size > 0 && Array.isArray(subs.filings.files)) {
    for (const file of subs.filings.files) {
      if (!file.name) continue;
      const page = await edgar.getSubmissionsPage(file.name);
      const rows = collectFromRecent(page, filerCIK, subs.name, targetPeriods);
      out.push(...rows);
    }
  }

  out.sort(
    (a, b) =>
      a.filingDate.localeCompare(b.filingDate) ||
      a.accessionNumber.localeCompare(b.accessionNumber),
  );
  return out;
}

function collectFromSubmissions(
  subs: EdgarSubmissions,
  filerCIK: string,
  targetPeriods: ReadonlySet<string>,
): DiscoveredFiling[] {
  return collectFromRecent(subs.filings.recent, filerCIK, subs.name, targetPeriods);
}

function collectFromRecent(
  recent: EdgarSubmissions['filings']['recent'],
  filerCIK: string,
  filerName: string,
  targetPeriods: ReadonlySet<string>,
): DiscoveredFiling[] {
  const forms = recent.form ?? [];
  const accs = recent.accessionNumber ?? [];
  const dates = recent.filingDate ?? [];
  const primaries = recent.primaryDocument ?? [];
  // SEC's submissions index uses `reportDate` for the quarter-end of a
  // periodic filing. We carry it forward internally as `periodOfReport`
  // (the name the cover-page XML uses) for shape consistency downstream.
  const periods = recent.reportDate ?? [];
  const out: DiscoveredFiling[] = [];

  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    if (form !== '13F-HR' && form !== '13F-HR/A') continue;
    const period = periods[i] || null;
    // Skip filings without periodOfReport: they can't be matched against the
    // target window, and pre-2013 paper-format 13Fs don't have the
    // primary_doc.xml the parser expects.
    if (!period) continue;
    if (!targetPeriods.has(period)) continue;
    out.push({
      filerCIK,
      filerName,
      accessionNumber: accs[i] ?? '',
      form,
      isAmendment: form === '13F-HR/A',
      filingDate: dates[i] ?? '',
      periodOfReport: period,
      primaryDocument: primaries[i] ?? '',
    });
  }
  return out;
}

function computeMissingPeriods(
  found: DiscoveredFiling[],
  target: ReadonlySet<string>,
): Set<string> {
  const have = new Set<string>();
  for (const f of found) if (f.periodOfReport) have.add(f.periodOfReport);
  const missing = new Set<string>();
  for (const p of target) if (!have.has(p)) missing.add(p);
  return missing;
}

/**
 * Build the target-periods set for the most-recent N quarters relative to
 * `today` (inclusive of the most recently completed quarter). 13F-HR is
 * filed up to 45 days after quarter end so we don't include the in-progress
 * quarter.
 */
export function recentQuarterEnds(today: Date, n: number): string[] {
  const out: string[] = [];
  let y = today.getUTCFullYear();
  const m0 = today.getUTCMonth(); // 0–11
  // Most recently *completed* quarter-end month (0-indexed: 2/5/8/11) on
  // or before today. Jan/Feb (m0 < 2) wraps to last December → previous year.
  let qm: number;
  if (m0 >= 11) qm = 11;
  else if (m0 >= 8) qm = 8;
  else if (m0 >= 5) qm = 5;
  else if (m0 >= 2) qm = 2;
  else {
    qm = 11;
    y -= 1;
  }
  for (let i = 0; i < n; i++) {
    const day = lastDayOfMonthUTC(y, qm);
    out.push(`${y}-${String(qm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    // Step back one quarter.
    if (qm === 2) {
      qm = 11;
      y -= 1;
    } else {
      qm -= 3;
    }
  }
  return out;
}

function lastDayOfMonthUTC(year: number, month: number): number {
  // Day 0 of the next month is the last day of `month`.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
