// Conviction tiering + pctOfBook computation tests.
// Boundary cases at exactly 0.0025 / 0.01 / 0.05 are the contract-locked
// thresholds (docs/PRODUCT_CONTRACT.md §9).

import { describe, it, expect } from 'vitest';
import { computePctOfBook, convictionTier, ConvictionInputError } from '../../src/domain/index.js';

describe('convictionTier — boundaries', () => {
  it('exactly 0.05 → core (boundary inclusive)', () => {
    expect(convictionTier(0.05)).toBe('core');
  });

  it('just below 0.05 → meaningful', () => {
    expect(convictionTier(0.0499)).toBe('meaningful');
  });

  it('exactly 0.01 → meaningful (boundary inclusive)', () => {
    expect(convictionTier(0.01)).toBe('meaningful');
  });

  it('just below 0.01 → starter', () => {
    expect(convictionTier(0.0099)).toBe('starter');
  });

  it('exactly 0.0025 → starter (boundary inclusive)', () => {
    expect(convictionTier(0.0025)).toBe('starter');
  });

  it('just below 0.0025 → scout', () => {
    expect(convictionTier(0.0024)).toBe('scout');
  });

  it('zero → scout', () => {
    expect(convictionTier(0)).toBe('scout');
  });

  it('one (100% of book) → core', () => {
    expect(convictionTier(1)).toBe('core');
  });
});

describe('convictionTier — invalid inputs', () => {
  it('throws on NaN', () => {
    expect(() => convictionTier(NaN)).toThrow(ConvictionInputError);
  });

  it('throws on negative', () => {
    expect(() => convictionTier(-0.01)).toThrow(ConvictionInputError);
  });

  it('throws on > 1 (input is a fraction, not a percentage)', () => {
    expect(() => convictionTier(1.01)).toThrow(ConvictionInputError);
  });

  it('throws on Infinity', () => {
    expect(() => convictionTier(Number.POSITIVE_INFINITY)).toThrow(ConvictionInputError);
  });
});

describe('computePctOfBook', () => {
  it('returns 0 when book is 0', () => {
    expect(computePctOfBook(100n, 0n)).toBe(0);
  });

  it('returns 0 when value is 0', () => {
    expect(computePctOfBook(0n, 1_000_000n)).toBe(0);
  });

  it('preserves precision for typical V1 inputs', () => {
    // POOL CORP at 0.18% of Berkshire's 274,160,086,701 book.
    const v = 122_334_566n;
    const book = 274_160_086_701n;
    const out = computePctOfBook(v, book);
    expect(out).toBeCloseTo(0.000446, 5);
  });

  it('preserves precision for trillion-dollar books', () => {
    const v = 5_000_000_000_000n;
    const book = 100_000_000_000_000n;
    expect(computePctOfBook(v, book)).toBe(0.05);
  });

  it('paired with convictionTier yields the expected tier across the range', () => {
    expect(convictionTier(computePctOfBook(50n, 1000n))).toBe('core'); // 5%
    expect(convictionTier(computePctOfBook(20n, 1000n))).toBe('meaningful'); // 2%
    expect(convictionTier(computePctOfBook(5n, 1000n))).toBe('starter'); // 0.5%
    expect(convictionTier(computePctOfBook(1n, 1000n))).toBe('scout'); // 0.1%
  });
});
