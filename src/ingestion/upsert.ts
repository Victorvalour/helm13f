// Persist a parsed filing into Postgres + run CUSIP resolution.
//
// All filer/filing/holdings writes for a single accession happen inside one
// transaction so partial writes don't pollute later queries. Holdings rows
// are computed AFTER the (cusip, putCall) aggregation that the parser
// already performed; per-row pctOfBook + convictionTier are computed here
// from the cover-page book value.

import { type Database, FilersRepo, FilingsRepo, HoldingsRepo } from '../db/index.js';
import { computePctOfBook, convictionTier } from '../domain/index.js';
import { normalizeValueToUSD, type AggregatedHolding } from '../parser/index.js';
import type { CusipResolver } from '../sources/openfigi/index.js';
import type { FetchedFiling } from './parse.js';

export interface PersistFilingResult {
  accessionNumber: string;
  holdingsUpserted: number;
  cusipsResolvedNew: number;
  isAmendment: boolean;
  /** Set when this filing is a 13F-HR/A and a prior 13F-HR was marked superseded. */
  superseded: string | null;
}

export interface PersistFilingOptions {
  /** Optional roster lookup for displayName/superinvestorTier hydration. */
  rosterLookup?: (cik: string) => {
    displayName: string;
    superinvestorTier: 'legendary' | 'well-known' | 'notable';
    primaryStrategy: string | null;
    aliases: string[];
  } | null;
}

/** Persist a fetched + parsed filing. Driven entirely by `fetched` + the
 *  caller-supplied accessionNumber + filingDate. */
export async function persistFiling(
  db: Database,
  filerCIK: string,
  accessionNumber: string,
  filingDate: string,
  fetched: FetchedFiling,
  cusipResolver: CusipResolver,
  opts: PersistFilingOptions = {},
): Promise<PersistFilingResult> {
  const { primaryDoc, holdings, bookValueUSD, valueScale } = fetched;

  // 1. Resolve CUSIPs first (outside the tx so we don't hold a connection
  //    while OpenFIGI is in flight). The resolver's own cache layer takes
  //    care of repeat calls.
  const cusips = Array.from(new Set(holdings.map((h) => h.cusip)));
  const resolved = await cusipResolver.resolveBatch(cusips);

  // 2. Upsert filer + filing + holdings inside one tx.
  return db.withTx(async (tx) => {
    const filersRepo = new FilersRepo(tx);
    const filingsRepo = new FilingsRepo(tx);
    const holdingsRepo = new HoldingsRepo(tx);

    // Hydrate filer-roster fields when available.
    const roster = opts.rosterLookup?.(filerCIK) ?? null;
    if (roster) {
      await filersRepo.upsert({
        filerCIK,
        filerName: primaryDoc.filerName,
        displayName: roster.displayName,
        isSuperinvestor: true,
        superinvestorTier: roster.superinvestorTier,
        primaryStrategy: roster.primaryStrategy,
        aliases: roster.aliases,
      });
    } else {
      await filersRepo.upsert({
        filerCIK,
        filerName: primaryDoc.filerName,
        isSuperinvestor: false,
        superinvestorTier: null,
      });
    }

    // Amendment handling: if this is a 13F-HR/A, mark any existing
    // non-amended, non-already-superseded 13F-HR for the same
    // (filer, period) as superseded by this accession.
    let supersededAccession: string | null = null;
    if (primaryDoc.isAmendment) {
      const existing = await filingsRepo.listByFilerAndPeriod(filerCIK, primaryDoc.periodOfReport);
      for (const e of existing) {
        if (
          e.accessionNumber !== accessionNumber &&
          e.supersededByAccession === null &&
          !e.isAmendment
        ) {
          await filingsRepo.markSuperseded(e.accessionNumber, accessionNumber);
          supersededAccession = e.accessionNumber;
          break;
        }
      }
    }

    // Filing upsert.
    await filingsRepo.upsert({
      accessionNumber,
      filerCIK,
      form: primaryDoc.submissionType,
      isAmendment: primaryDoc.isAmendment,
      periodOfReport: primaryDoc.periodOfReport,
      filingDate,
      bookValueUSD,
      valueScale,
      tableEntryTotal: primaryDoc.tableEntryTotal,
      primaryDocURL: fetched.primaryDocURL,
      infoTableURL: fetched.infoTableURL,
      infoTableFilename: fetched.infoTableFilename,
    });

    // Holdings upsert.
    const upserts = holdings.map((h) =>
      makeHoldingUpsert(
        accessionNumber,
        filerCIK,
        primaryDoc.periodOfReport,
        h,
        bookValueUSD,
        valueScale,
        resolved.get(h.cusip)?.ticker ?? null,
      ),
    );
    const n = await holdingsRepo.upsertManyForFiling(upserts);

    return {
      accessionNumber,
      holdingsUpserted: n,
      cusipsResolvedNew: cusips.length,
      isAmendment: primaryDoc.isAmendment,
      superseded: supersededAccession,
    };
  });
}

function makeHoldingUpsert(
  accessionNumber: string,
  filerCIK: string,
  periodOfReport: string,
  h: AggregatedHolding,
  bookValueUSD: bigint,
  valueScale: 'USD' | 'USD_THOUSANDS',
  ticker: string | null,
) {
  const valueUSD = normalizeValueToUSD(h.valueRaw, valueScale);
  const pct = computePctOfBook(valueUSD, bookValueUSD);
  const tier = convictionTier(Math.min(1, Math.max(0, pct)));
  return {
    accessionNumber,
    filerCIK,
    periodOfReport,
    cusip: h.cusip,
    ticker,
    issuerName: h.nameOfIssuer,
    titleOfClass: h.titleOfClass,
    shares: h.shares,
    valueUSD,
    pctOfBook: pct,
    convictionTier: tier,
    sshPrnamtType: h.sshPrnamtType,
    putCall: h.putCall,
    investmentDiscretion: h.investmentDiscretion,
    votingSole: h.votingAuthority.sole,
    votingShared: h.votingAuthority.shared,
    votingNone: h.votingAuthority.none,
  };
}
