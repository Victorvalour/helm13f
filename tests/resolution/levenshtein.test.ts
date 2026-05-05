// Levenshtein distance unit tests.

import { describe, it, expect } from 'vitest';
import { levenshtein, similarity } from '../../src/resolution/index.js';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('foo', 'foo')).toBe(0);
  });

  it('returns the length of the non-empty string when one is empty', () => {
    expect(levenshtein('', 'foo')).toBe(3);
    expect(levenshtein('foo', '')).toBe(3);
  });

  it('counts substitutions, insertions, and deletions correctly', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('saturday', 'sunday')).toBe(3);
    expect(levenshtein('flaw', 'lawn')).toBe(2);
  });

  it('is symmetric', () => {
    expect(levenshtein('berkshire', 'berkshyre')).toBe(levenshtein('berkshyre', 'berkshire'));
  });
});

describe('similarity', () => {
  it('returns 1 for identical strings', () => {
    expect(similarity('foo', 'foo')).toBe(1);
  });

  it('returns 0 for completely different strings of the same length', () => {
    expect(similarity('abc', 'xyz')).toBe(0);
  });

  it('returns ~0.86 for berkshire / berkshyre (1 substitution / 9 chars)', () => {
    expect(similarity('berkshire', 'berkshyre')).toBeCloseTo(0.888, 2);
  });

  it('returns 1 for two empty strings', () => {
    expect(similarity('', '')).toBe(1);
  });
});
