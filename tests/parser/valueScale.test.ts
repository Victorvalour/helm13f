// Tests for value-scale detection + normalization (Phase 0 calibration 1).
//
// The contract: pre-2023-Q3 13Fs report value in thousands of dollars,
// post-2023-Q3 in dollars. The parser implements both code paths even
// though V1 only ingests post-2023 data; the boundary is unit-tested.

import { describe, it, expect } from 'vitest';
import {
  detectValueScale,
  normalizeValueToUSD,
  ValueScaleError,
  VALUE_SCALE_BOUNDARY_FILED_AT,
} from '../../src/parser/index.js';

describe('detectValueScale boundary', () => {
  it('uses USD on or after 2023-08-15', () => {
    expect(detectValueScale('2023-08-15')).toBe('USD');
    expect(detectValueScale('2024-01-01')).toBe('USD');
    expect(detectValueScale('2026-02-17')).toBe('USD');
  });

  it('uses USD_THOUSANDS strictly before 2023-08-15', () => {
    expect(detectValueScale('2023-08-14')).toBe('USD_THOUSANDS');
    expect(detectValueScale('2023-05-15')).toBe('USD_THOUSANDS');
    expect(detectValueScale('2017-02-14')).toBe('USD_THOUSANDS');
  });

  it('throws on non-ISO input', () => {
    expect(() => detectValueScale('05-15-2023')).toThrow(ValueScaleError);
    expect(() => detectValueScale('2023')).toThrow(ValueScaleError);
  });

  it('exposes the boundary constant', () => {
    expect(VALUE_SCALE_BOUNDARY_FILED_AT).toBe('2023-08-15');
  });
});

describe('normalizeValueToUSD', () => {
  it('passes USD values through unchanged', () => {
    expect(normalizeValueToUSD(0, 'USD')).toBe(0n);
    expect(normalizeValueToUSD(1_313_410_001, 'USD')).toBe(1_313_410_001n);
    expect(normalizeValueToUSD(274_160_086_701n, 'USD')).toBe(274_160_086_701n);
  });

  it('multiplies USD_THOUSANDS values by 1000', () => {
    expect(normalizeValueToUSD(0, 'USD_THOUSANDS')).toBe(0n);
    expect(normalizeValueToUSD(1_000, 'USD_THOUSANDS')).toBe(1_000_000n);
    // Synthetic: a 2017-era filing reporting 66_075 in thousands → $66,075,000.
    expect(normalizeValueToUSD(66_075n, 'USD_THOUSANDS')).toBe(66_075_000n);
  });

  it('preserves precision for very large values via bigint', () => {
    // 274,160,086 thousand → 274,160,086,000 — well above 2^53.
    const huge = 274_160_086n;
    expect(normalizeValueToUSD(huge, 'USD_THOUSANDS')).toBe(274_160_086_000n);
  });
});
