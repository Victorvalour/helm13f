// Cluster detection — identify when 3+ curated superinvestors had a 'new'
// or 'add' event on the same ticker in one filing season.
//
// Per docs/PRODUCT_CONTRACT.md §9:
//   - memberCount = |{filers with new or add on T in Q}|
//   - if memberCount < 3 → no cluster (return null)
//   - tier = weak (3-4) | notable (5-7) | strong (>=8)
//   - strength = sum_over_members(pctOfBookDelta) where for 'new' events
//     priorPctOfBook is null and treated as 0.
//
// Calibration 7 envelope-level invariant (asserted in the Q5 contract test
// suite): clusterSignal.strength === sum(rows[i].pctOfBookDelta). The
// detectCluster() function below returns BOTH the cluster signal and the
// per-member events so callers can populate the Q5 envelope's `rows` and
// `clusterSignal` from a single source of truth.

export type ClusterTier = 'weak' | 'notable' | 'strong';
export type ClusterEventType = 'new' | 'add';

export interface ClusterEventInput {
  filerCIK: string;
  /** 'new' if this is a fresh initiation; 'add' if a material increase. */
  eventType: ClusterEventType;
  /** Current-quarter pctOfBook (decimal in [0, 1]). */
  currentPctOfBook: number;
  /** Prior-quarter pctOfBook. null for 'new' events; required for 'add'. */
  priorPctOfBook: number | null;
}

export interface ClusterEventOutput extends ClusterEventInput {
  /** currentPctOfBook - (priorPctOfBook ?? 0). */
  pctOfBookDelta: number;
}

export interface ClusterSignalOutput {
  detected: true;
  tier: ClusterTier;
  memberCount: number;
  memberCIKs: string[];
  /** Sum of pctOfBookDelta across all events. */
  strength: number;
}

export interface ClusterDetectionResult {
  signal: ClusterSignalOutput | null;
  /** Rows with `pctOfBookDelta` populated; same order as input (deduped per CIK if duplicated). */
  rows: ClusterEventOutput[];
}

export class ClusterInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterInputError';
  }
}

/**
 * Detect a cluster from a list of cluster-event candidates filtered to
 * curated superinvestors. Caller is responsible for the curation step.
 *
 * Behaviour:
 *   - Validates each event's pctOfBook fields are in [0, 1].
 *   - Validates the 'new' ↔ priorPctOfBook=null invariant; throws otherwise.
 *   - Dedupes by filerCIK keeping the last entry (a filer can only contribute
 *     once to a cluster).
 *   - Returns { signal: null, rows: [] } when fewer than 3 unique members.
 *   - Otherwise returns { signal, rows } where:
 *       signal.strength === sum(rows[i].pctOfBookDelta)  (envelope invariant)
 */
export function detectCluster(events: readonly ClusterEventInput[]): ClusterDetectionResult {
  const dedup = new Map<string, ClusterEventInput>();
  for (const e of events) validateEvent(e);
  for (const e of events) dedup.set(e.filerCIK, e);

  const rows: ClusterEventOutput[] = [];
  for (const e of dedup.values()) {
    const delta = e.currentPctOfBook - (e.priorPctOfBook ?? 0);
    rows.push({ ...e, pctOfBookDelta: round6(delta) });
  }

  if (rows.length < 3) return { signal: null, rows: [] };

  const strength = round6(rows.reduce((acc, r) => acc + r.pctOfBookDelta, 0));
  const memberCIKs = rows.map((r) => r.filerCIK);

  const signal: ClusterSignalOutput = {
    detected: true,
    tier: tierFromCount(rows.length),
    memberCount: rows.length,
    memberCIKs,
    strength,
  };
  return { signal, rows };
}

/** weak (3-4) | notable (5-7) | strong (>=8) */
export function tierFromCount(memberCount: number): ClusterTier {
  if (memberCount >= 8) return 'strong';
  if (memberCount >= 5) return 'notable';
  return 'weak';
}

function validateEvent(e: ClusterEventInput): void {
  if (e.eventType !== 'new' && e.eventType !== 'add') {
    throw new ClusterInputError(
      `detectCluster: invalid eventType for ${e.filerCIK}: '${String(e.eventType)}'`,
    );
  }
  if (!Number.isFinite(e.currentPctOfBook) || e.currentPctOfBook < 0 || e.currentPctOfBook > 1) {
    throw new ClusterInputError(
      `detectCluster: currentPctOfBook out of [0, 1] for ${e.filerCIK}: ${e.currentPctOfBook}`,
    );
  }
  if (e.eventType === 'new' && e.priorPctOfBook !== null) {
    throw new ClusterInputError(
      `detectCluster: 'new' event for ${e.filerCIK} must have priorPctOfBook=null (got ${e.priorPctOfBook})`,
    );
  }
  if (e.eventType === 'add') {
    if (e.priorPctOfBook === null) {
      throw new ClusterInputError(
        `detectCluster: 'add' event for ${e.filerCIK} requires non-null priorPctOfBook`,
      );
    }
    if (!Number.isFinite(e.priorPctOfBook) || e.priorPctOfBook < 0 || e.priorPctOfBook > 1) {
      throw new ClusterInputError(
        `detectCluster: priorPctOfBook out of [0, 1] for ${e.filerCIK}: ${e.priorPctOfBook}`,
      );
    }
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
