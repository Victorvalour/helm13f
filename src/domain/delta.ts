// Delta classification — pure function over (prior, current) holding states.
//
// Per docs/PRODUCT_CONTRACT.md §9:
//   new       cusip in current AND not in prior
//   exit      cusip in prior AND not in current
//   add       currentShares > priorShares * 1.25
//   trim      currentShares < priorShares * 0.75
//   unchanged otherwise
//
// Boundary tests: currentShares == priorShares*1.25 → unchanged (strict >).
//                 currentShares == priorShares*0.75 → unchanged (strict <).
//
// Inputs use bigint to preserve precision for very large share counts.
// The 1.25 / 0.75 multipliers are computed via exact bigint arithmetic
// (×125 / ×75 then divide-by-100 with strict >/< on the integer result).

export type DeltaType = 'new' | 'exit' | 'add' | 'trim' | 'unchanged';

/** Threshold for material adds (strict >). */
export const ADD_THRESHOLD_PCT = 0.25;
/** Threshold for material trims (strict <). */
export const TRIM_THRESHOLD_PCT = 0.25;

export class DeltaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeltaInputError';
  }
}

export interface DeltaState {
  /** Prior-quarter aggregated share count for the (cusip, putCall). null when not held. */
  priorShares: bigint | null;
  /** Current-quarter aggregated share count for the (cusip, putCall). null when not held. */
  currentShares: bigint | null;
}

/**
 * Classify the delta between prior and current holding states for a single
 * (cusip, putCall) bucket. Caller MUST aggregate raw rows by (cusip, putCall)
 * before calling — see infoTable.parseInfoTable() (Phase 0 calibration 3).
 *
 * The minDeltaPct override lets Q3 callers tighten the threshold (default
 * 0.25). When current == prior shares (no change), result is 'unchanged'.
 */
export function classifyDelta(
  state: DeltaState,
  minDeltaPct: number = ADD_THRESHOLD_PCT,
): DeltaType {
  if (!Number.isFinite(minDeltaPct) || minDeltaPct < 0) {
    throw new DeltaInputError(`classifyDelta: minDeltaPct must be >= 0, got ${minDeltaPct}`);
  }
  const { priorShares, currentShares } = state;

  if (priorShares === null && currentShares === null) {
    throw new DeltaInputError(
      'classifyDelta: both priorShares and currentShares are null (no state)',
    );
  }
  if (priorShares !== null && priorShares < 0n) {
    throw new DeltaInputError(`priorShares must be >= 0, got ${priorShares}`);
  }
  if (currentShares !== null && currentShares < 0n) {
    throw new DeltaInputError(`currentShares must be >= 0, got ${currentShares}`);
  }

  if (priorShares === null && currentShares !== null) {
    return currentShares > 0n ? 'new' : 'unchanged';
  }
  if (priorShares !== null && currentShares === null) {
    return priorShares > 0n ? 'exit' : 'unchanged';
  }
  // Both are non-null at this point.
  const p = priorShares as bigint;
  const c = currentShares as bigint;

  if (p === 0n && c === 0n) return 'unchanged';
  if (p === 0n && c > 0n) return 'new';
  if (c === 0n && p > 0n) return 'exit';

  // Compute strict > / < against p * (1 + minDeltaPct) and p * (1 - minDeltaPct).
  // We use fixed-point bigint arithmetic to avoid fp drift on the boundary.
  // Scale: 1e6 (six decimal places of precision on minDeltaPct).
  const SCALE = 1_000_000n;
  const numAdd = BigInt(Math.round((1 + minDeltaPct) * 1_000_000));
  const numTrim = BigInt(Math.round((1 - minDeltaPct) * 1_000_000));
  const cScaled = c * SCALE;
  const pAdd = p * numAdd;
  const pTrim = p * numTrim;

  if (cScaled > pAdd) return 'add';
  if (cScaled < pTrim) return 'trim';
  return 'unchanged';
}

/**
 * Convenience: shareDeltaPct = (current - prior) / prior. Returns 0 when
 * prior is 0 or null. Result is a decimal (0.5 = +50%, -0.4 = -40%).
 */
export function shareDeltaPct(priorShares: bigint | null, currentShares: bigint | null): number {
  if (priorShares === null || priorShares === 0n) return 0;
  if (currentShares === null) return -1;
  // (current - prior) / prior, via fixed-point bigint.
  const SCALE = 1_000_000n;
  const diff = currentShares - priorShares;
  const scaled = (diff * SCALE) / priorShares;
  return Number(scaled) / Number(SCALE);
}
