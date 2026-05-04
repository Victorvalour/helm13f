// Delta classification boundary tests.
//
// Contract: add when currentShares > priorShares*1.25; trim when
// currentShares < priorShares*0.75. Boundaries strictly excluded
// (currentShares == priorShares*1.25 → unchanged).

import { describe, it, expect } from 'vitest';
import { classifyDelta, shareDeltaPct, DeltaInputError } from '../../src/domain/index.js';

describe('classifyDelta — new / exit', () => {
  it("'new' when prior is null and current > 0", () => {
    expect(classifyDelta({ priorShares: null, currentShares: 1_000n })).toBe('new');
  });

  it("'exit' when current is null and prior > 0", () => {
    expect(classifyDelta({ priorShares: 1_000n, currentShares: null })).toBe('exit');
  });

  it("'unchanged' when prior is null and current is 0", () => {
    expect(classifyDelta({ priorShares: null, currentShares: 0n })).toBe('unchanged');
  });

  it("'unchanged' when prior is 0 and current is 0", () => {
    expect(classifyDelta({ priorShares: 0n, currentShares: 0n })).toBe('unchanged');
  });

  it("'new' when prior is 0 and current > 0", () => {
    expect(classifyDelta({ priorShares: 0n, currentShares: 100n })).toBe('new');
  });

  it("'exit' when current is 0 and prior > 0", () => {
    expect(classifyDelta({ priorShares: 100n, currentShares: 0n })).toBe('exit');
  });

  it('throws when both prior and current are null', () => {
    expect(() => classifyDelta({ priorShares: null, currentShares: null })).toThrow(
      DeltaInputError,
    );
  });
});

describe('classifyDelta — add / trim / unchanged at the ±25% boundary', () => {
  it('exactly +25% → unchanged (strict > on add boundary)', () => {
    // 1,000,000 → 1,250,000 (exactly +25%).
    expect(
      classifyDelta({
        priorShares: 1_000_000n,
        currentShares: 1_250_000n,
      }),
    ).toBe('unchanged');
  });

  it('+25% + 1 share → add', () => {
    expect(
      classifyDelta({
        priorShares: 1_000_000n,
        currentShares: 1_250_001n,
      }),
    ).toBe('add');
  });

  it('exactly -25% → unchanged (strict < on trim boundary)', () => {
    expect(
      classifyDelta({
        priorShares: 1_000_000n,
        currentShares: 750_000n,
      }),
    ).toBe('unchanged');
  });

  it('-25% - 1 share → trim', () => {
    expect(
      classifyDelta({
        priorShares: 1_000_000n,
        currentShares: 749_999n,
      }),
    ).toBe('trim');
  });

  it('large add (+50%) → add', () => {
    expect(classifyDelta({ priorShares: 1_000n, currentShares: 1_500n })).toBe('add');
  });

  it('small change within ±25% → unchanged', () => {
    expect(classifyDelta({ priorShares: 1_000n, currentShares: 1_100n })).toBe('unchanged');
    expect(classifyDelta({ priorShares: 1_000n, currentShares: 900n })).toBe('unchanged');
  });
});

describe('classifyDelta — minDeltaPct override', () => {
  it('respects a tighter 10% threshold', () => {
    // +12% with default threshold 25% → unchanged
    expect(classifyDelta({ priorShares: 1_000n, currentShares: 1_120n })).toBe('unchanged');
    // ... but with threshold 10% → add
    expect(classifyDelta({ priorShares: 1_000n, currentShares: 1_120n }, 0.1)).toBe('add');
  });

  it('respects a looser 50% threshold', () => {
    // +30% with threshold 50% → unchanged
    expect(classifyDelta({ priorShares: 1_000n, currentShares: 1_300n }, 0.5)).toBe('unchanged');
  });

  it('throws on negative minDeltaPct', () => {
    expect(() => classifyDelta({ priorShares: 1_000n, currentShares: 1_300n }, -0.1)).toThrow(
      DeltaInputError,
    );
  });
});

describe('classifyDelta — invalid share counts', () => {
  it('throws on negative priorShares', () => {
    expect(() => classifyDelta({ priorShares: -1n, currentShares: 100n })).toThrow(DeltaInputError);
  });

  it('throws on negative currentShares', () => {
    expect(() => classifyDelta({ priorShares: 100n, currentShares: -1n })).toThrow(DeltaInputError);
  });
});

describe('shareDeltaPct', () => {
  it('+50% returns 0.5', () => {
    expect(shareDeltaPct(1_000n, 1_500n)).toBe(0.5);
  });

  it('-40% returns -0.4', () => {
    expect(shareDeltaPct(1_000n, 600n)).toBe(-0.4);
  });

  it('returns 0 when prior is null or 0', () => {
    expect(shareDeltaPct(null, 100n)).toBe(0);
    expect(shareDeltaPct(0n, 100n)).toBe(0);
  });

  it('returns -1 when current is null (exit)', () => {
    expect(shareDeltaPct(100n, null)).toBe(-1);
  });
});
