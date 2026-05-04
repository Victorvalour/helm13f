// Cluster detection tests + the envelope-level
// strength === sum(rows[i].pctOfBookDelta) invariant from calibration 7.

import { describe, it, expect } from 'vitest';
import {
  detectCluster,
  tierFromCount,
  ClusterInputError,
  type ClusterEventInput,
} from '../../src/domain/index.js';

function newEvent(cik: string, current: number): ClusterEventInput {
  return {
    filerCIK: cik,
    eventType: 'new',
    currentPctOfBook: current,
    priorPctOfBook: null,
  };
}

function addEvent(cik: string, prior: number, current: number): ClusterEventInput {
  return {
    filerCIK: cik,
    eventType: 'add',
    currentPctOfBook: current,
    priorPctOfBook: prior,
  };
}

describe('tierFromCount', () => {
  it('3 → weak', () => expect(tierFromCount(3)).toBe('weak'));
  it('4 → weak', () => expect(tierFromCount(4)).toBe('weak'));
  it('5 → notable', () => expect(tierFromCount(5)).toBe('notable'));
  it('7 → notable', () => expect(tierFromCount(7)).toBe('notable'));
  it('8 → strong', () => expect(tierFromCount(8)).toBe('strong'));
  it('15 → strong', () => expect(tierFromCount(15)).toBe('strong'));
});

describe('detectCluster — < 3 members', () => {
  it('returns null signal and empty rows for empty input', () => {
    const out = detectCluster([]);
    expect(out.signal).toBeNull();
    expect(out.rows).toEqual([]);
  });

  it('returns null signal for 1 member', () => {
    const out = detectCluster([newEvent('0001067983', 0.01)]);
    expect(out.signal).toBeNull();
  });

  it('returns null signal for 2 members', () => {
    const out = detectCluster([newEvent('0001067983', 0.01), addEvent('0001649339', 0.005, 0.02)]);
    expect(out.signal).toBeNull();
  });
});

describe('detectCluster — tier mapping', () => {
  function makeMembers(n: number): ClusterEventInput[] {
    const out: ClusterEventInput[] = [];
    for (let i = 0; i < n; i++) {
      const cik = String(i).padStart(10, '0');
      out.push(newEvent(cik, 0.01));
    }
    return out;
  }

  it('3 members → weak', () => {
    const out = detectCluster(makeMembers(3));
    expect(out.signal?.tier).toBe('weak');
    expect(out.signal?.memberCount).toBe(3);
  });

  it('5 members → notable', () => {
    const out = detectCluster(makeMembers(5));
    expect(out.signal?.tier).toBe('notable');
  });

  it('8 members → strong', () => {
    const out = detectCluster(makeMembers(8));
    expect(out.signal?.tier).toBe('strong');
  });
});

describe('detectCluster — strength === sum(rows[i].pctOfBookDelta) invariant (calibration 7)', () => {
  it('3 "new" events: strength == sum of currentPctOfBook (priorPctOfBook=0 for new)', () => {
    const events = [
      newEvent('0001067983', 0.0018),
      newEvent('0001336528', 0.025),
      newEvent('0001113169', 0.011),
    ];
    const out = detectCluster(events);
    const expected = 0.0018 + 0.025 + 0.011;
    expect(out.signal?.strength).toBeCloseTo(expected, 6);
    const rowSum = out.rows.reduce((acc, r) => acc + r.pctOfBookDelta, 0);
    expect(out.signal?.strength).toBeCloseTo(rowSum, 6);
  });

  it("mix of 'new' and 'add' events: strength == sum of (current - (prior ?? 0))", () => {
    const events = [
      newEvent('0001067983', 0.0018), // delta = 0.0018
      addEvent('0001649339', 0.0085, 0.0135), // delta = 0.005
      newEvent('0001336528', 0.025), // delta = 0.025
      addEvent('0001029160', 0.0028, 0.0082), // delta = 0.0054
      newEvent('0001113169', 0.011), // delta = 0.011
    ];
    const out = detectCluster(events);
    expect(out.signal?.tier).toBe('notable');
    expect(out.signal?.memberCount).toBe(5);
    const expected = 0.0018 + 0.005 + 0.025 + 0.0054 + 0.011;
    expect(out.signal?.strength).toBeCloseTo(expected, 6);
    const rowSum = out.rows.reduce((acc, r) => acc + r.pctOfBookDelta, 0);
    expect(out.signal?.strength).toBeCloseTo(rowSum, 6);
  });

  it('every row has pctOfBookDelta = currentPctOfBook - (priorPctOfBook ?? 0)', () => {
    const events = [
      newEvent('A0000000', 0.012),
      addEvent('B0000000', 0.004, 0.018),
      addEvent('C0000000', 0.001, 0.005),
    ];
    const out = detectCluster(events);
    for (const r of out.rows) {
      const expected = r.currentPctOfBook - (r.priorPctOfBook ?? 0);
      expect(r.pctOfBookDelta).toBeCloseTo(expected, 6);
    }
  });
});

describe('detectCluster — dedupe + member ordering', () => {
  it('dedupes by filerCIK keeping the last entry', () => {
    const events = [
      newEvent('0001067983', 0.001),
      addEvent('0001067983', 0.005, 0.02), // same CIK, dup
      newEvent('0001649339', 0.01),
      newEvent('0001336528', 0.02),
    ];
    const out = detectCluster(events);
    expect(out.signal?.memberCount).toBe(3);
    const buffett = out.rows.find((r) => r.filerCIK === '0001067983');
    expect(buffett?.eventType).toBe('add');
    expect(buffett?.pctOfBookDelta).toBeCloseTo(0.015, 6);
  });
});

describe('detectCluster — invariant validation', () => {
  it("throws when 'new' has non-null priorPctOfBook", () => {
    const bad: ClusterEventInput = {
      filerCIK: 'A',
      eventType: 'new',
      currentPctOfBook: 0.01,
      priorPctOfBook: 0.005,
    };
    expect(() => detectCluster([bad])).toThrow(ClusterInputError);
  });

  it("throws when 'add' has null priorPctOfBook", () => {
    const bad: ClusterEventInput = {
      filerCIK: 'A',
      eventType: 'add',
      currentPctOfBook: 0.01,
      priorPctOfBook: null,
    };
    expect(() => detectCluster([bad])).toThrow(ClusterInputError);
  });

  it('throws on currentPctOfBook out of [0, 1]', () => {
    expect(() =>
      detectCluster([
        {
          filerCIK: 'A',
          eventType: 'new',
          currentPctOfBook: 1.5,
          priorPctOfBook: null,
        },
      ]),
    ).toThrow(ClusterInputError);
  });

  it('throws on unknown eventType', () => {
    const bad = {
      filerCIK: 'A',
      eventType: 'trim',
      currentPctOfBook: 0.01,
      priorPctOfBook: null,
    } as unknown as ClusterEventInput;
    expect(() => detectCluster([bad])).toThrow(ClusterInputError);
  });
});
