// Backfill orchestrator — composes runIngestion(...) over the curated
// superinvestor roster × last N quarters. Used at cold-start (Phase 3.11)
// and as a manual remediation tool when the daily cron has gaps.
//
// Pure orchestration: takes the same dependencies as `runIngestion`
// plus a roster and `quarters`. Computes the (filerCIKs, targetPeriods)
// tuple, then delegates. Easy to unit-test against stubs.

import type { Database } from '../db/index.js';
import type { EdgarClient } from '../sources/edgar/index.js';
import type { CusipResolver } from '../sources/openfigi/index.js';
import type { RosterEntry } from '../resolution/index.js';
import { recentQuarterEnds, runIngestion, type IngestionRunSummary } from './index.js';

export interface BackfillOptions {
  roster: ReadonlyArray<RosterEntry>;
  /** Number of recent completed quarters to pull. Default 4. */
  quarters?: number;
  /** Override "today" for deterministic tests. */
  now?: () => Date;
  /** Optional subset of CIKs (defaults to roster.cik). */
  filerCIKs?: ReadonlyArray<string>;
  /** Optional explicit periods (overrides quarters-based derivation). */
  targetPeriods?: ReadonlyArray<string>;
}

export interface BackfillPlan {
  filerCIKs: ReadonlyArray<string>;
  targetPeriods: ReadonlyArray<string>;
  rosterByCik: ReadonlyMap<string, RosterEntry>;
}

/** Pure planning step — derives (filerCIKs, targetPeriods) without I/O. */
export function planBackfill(opts: BackfillOptions): BackfillPlan {
  const n = opts.quarters ?? 4;
  const today = opts.now?.() ?? new Date();
  const filerCIKs = opts.filerCIKs ?? opts.roster.map((r) => r.cik);
  const targetPeriods = opts.targetPeriods ?? recentQuarterEnds(today, n);
  const rosterByCik = new Map(opts.roster.map((r) => [r.cik, r]));
  return { filerCIKs, targetPeriods, rosterByCik };
}

/** Plan + execute. Returns the IngestionRunSummary from runIngestion. */
export async function runBackfill(
  opts: BackfillOptions,
  db: Database,
  edgar: EdgarClient,
  cusipResolver: CusipResolver,
): Promise<IngestionRunSummary> {
  const plan = planBackfill(opts);
  return runIngestion(
    {
      filerCIKs: plan.filerCIKs,
      targetPeriods: plan.targetPeriods,
      runKind: 'backfill',
      rosterLookup: (cik) => {
        const entry = plan.rosterByCik.get(cik);
        if (!entry || !entry.superinvestorTier) return null;
        return {
          displayName: entry.displayName,
          superinvestorTier: entry.superinvestorTier,
          primaryStrategy: entry.primaryStrategy ?? null,
          aliases: entry.aliases,
        };
      },
    },
    db,
    edgar,
    cusipResolver,
  );
}
