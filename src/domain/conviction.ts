// Conviction tiering — pure function from pctOfBook to a deterministic tier.
//
// Per docs/PRODUCT_CONTRACT.md §9:
//   core        if pctOfBook >= 0.05
//   meaningful  if 0.01 <= pctOfBook < 0.05
//   starter     if 0.0025 <= pctOfBook < 0.01
//   scout       if pctOfBook < 0.0025
//
// Boundaries: exactly 0.01 → meaningful, exactly 0.05 → core.

export type ConvictionTier = 'core' | 'meaningful' | 'starter' | 'scout';

export const CONVICTION_THRESHOLDS = {
  core: 0.05,
  meaningful: 0.01,
  starter: 0.0025,
} as const;

export class ConvictionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvictionInputError';
  }
}

/**
 * Classify a position's conviction tier from its `pctOfBook`
 * (decimal in [0, 1]; 5% = 0.05). Throws on negative or > 1 input.
 */
export function convictionTier(pctOfBook: number): ConvictionTier {
  if (!Number.isFinite(pctOfBook) || pctOfBook < 0 || pctOfBook > 1) {
    throw new ConvictionInputError(`convictionTier: pctOfBook must be in [0, 1], got ${pctOfBook}`);
  }
  if (pctOfBook >= CONVICTION_THRESHOLDS.core) return 'core';
  if (pctOfBook >= CONVICTION_THRESHOLDS.meaningful) return 'meaningful';
  if (pctOfBook >= CONVICTION_THRESHOLDS.starter) return 'starter';
  return 'scout';
}

/**
 * Compute pctOfBook from valueUSD and bookValueUSD. Returns 0 when book is 0
 * (rare edge case — a fresh filer with no holdings, but a 13F entry should
 * never satisfy this). Both inputs are bigint to preserve precision.
 */
export function computePctOfBook(valueUSD: bigint, bookValueUSD: bigint): number {
  if (bookValueUSD <= 0n) return 0;
  if (valueUSD <= 0n) return 0;
  // Convert to number with 6 decimal places of precision via fixed-point
  // arithmetic. (valueUSD * 10^9) / bookValueUSD then divide by 10^9.
  const SCALE = 1_000_000_000n;
  const scaled = (valueUSD * SCALE) / bookValueUSD;
  return Number(scaled) / Number(SCALE);
}
