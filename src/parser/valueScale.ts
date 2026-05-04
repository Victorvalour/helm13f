// Value-scale detection + normalization (Phase 0 calibration 1).
//
// Per the contract: pre-2023-Q3 13Fs reported `value` in thousands of dollars;
// post-2023-Q3 in dollars. The boundary date is 2023-08-15 (filings for the
// June 30, 2023 period of report and later). The parser detects scale from
// the filing date and normalizes raw cover-page / InfoTable values to dollars.
//
// In practice many large filers (Berkshire included) reported in actual
// dollars even pre-Q3-2023, so the heuristic is a sensible default rather
// than ground truth. Callers (the ingestion pipeline) can override per filer.

import type { ValueScale } from './types.js';

/**
 * Boundary at which SEC EDGAR's 13F value-units convention transitioned
 * from thousands-of-dollars to dollars. Filings filed on or after this
 * date use USD; before, USD_THOUSANDS by default.
 */
export const VALUE_SCALE_BOUNDARY_FILED_AT = '2023-08-15';

export class ValueScaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueScaleError';
  }
}

/**
 * Default heuristic: filings filed on or after VALUE_SCALE_BOUNDARY_FILED_AT
 * are USD; older are USD_THOUSANDS. Caller may override per filer.
 */
export function detectValueScale(filedAt: string): ValueScale {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(filedAt)) {
    throw new ValueScaleError(`detectValueScale: filedAt must be ISO YYYY-MM-DD, got ${filedAt}`);
  }
  return filedAt >= VALUE_SCALE_BOUNDARY_FILED_AT ? 'USD' : 'USD_THOUSANDS';
}

/**
 * Normalize a raw value from a 13F (cover-page or InfoTable) to dollars.
 * Multiplies by 1000 when valueScale === 'USD_THOUSANDS'.
 *
 * Accepts bigint or number. Returns bigint to preserve precision for very
 * large books (multi-trillion-dollar pre-2023 raw values when multiplied).
 */
export function normalizeValueToUSD(raw: number | bigint, valueScale: ValueScale): bigint {
  const big = typeof raw === 'bigint' ? raw : BigInt(Math.trunc(raw));
  if (valueScale === 'USD_THOUSANDS') {
    return big * 1000n;
  }
  return big;
}
