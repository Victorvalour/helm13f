// planBackfill — pure-function tests. The runBackfill orchestration
// is already exercised through runIngestion's tests.

import { describe, it, expect } from 'vitest';
import { planBackfill } from '../../src/ingestion/index.js';
import type { RosterEntry } from '../../src/resolution/index.js';

const ROSTER: RosterEntry[] = [
  {
    cik: '0001067983',
    displayName: 'Berkshire',
    edgarName: 'BERKSHIRE HATHAWAY INC',
    aliases: [],
    superinvestorTier: 'legendary',
    primaryStrategy: 'value',
  },
  {
    cik: '0001649339',
    displayName: 'Scion',
    edgarName: 'SCION ASSET MANAGEMENT, LLC',
    aliases: [],
    superinvestorTier: 'well-known',
    primaryStrategy: 'value',
  },
  {
    cik: '0001336528',
    displayName: 'Pershing',
    edgarName: 'Pershing Square Capital Management, L.P.',
    aliases: [],
    superinvestorTier: 'legendary',
    primaryStrategy: 'event-driven',
  },
];

describe('planBackfill', () => {
  it('default 4 quarters × full roster', () => {
    const plan = planBackfill({
      roster: ROSTER,
      now: () => new Date('2026-05-04T00:00:00Z'),
    });
    expect(plan.filerCIKs).toHaveLength(3);
    expect(plan.targetPeriods).toEqual(['2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30']);
    expect(plan.rosterByCik.get('0001067983')?.displayName).toBe('Berkshire');
  });

  it('honours custom quarters count', () => {
    const plan = planBackfill({
      roster: ROSTER,
      quarters: 2,
      now: () => new Date('2026-05-04T00:00:00Z'),
    });
    expect(plan.targetPeriods).toEqual(['2026-03-31', '2025-12-31']);
  });

  it('honours filerCIKs override (subset)', () => {
    const plan = planBackfill({
      roster: ROSTER,
      filerCIKs: ['0001067983'],
      now: () => new Date('2026-05-04T00:00:00Z'),
    });
    expect(plan.filerCIKs).toEqual(['0001067983']);
    // Roster map still includes all entries so lookup hydration works for
    // the subset's CIK.
    expect(plan.rosterByCik.size).toBe(3);
  });

  it('honours targetPeriods override', () => {
    const plan = planBackfill({
      roster: ROSTER,
      targetPeriods: ['2024-12-31'],
      now: () => new Date('2026-05-04T00:00:00Z'),
    });
    expect(plan.targetPeriods).toEqual(['2024-12-31']);
  });

  it('rosterByCik is keyed by CIK for O(1) hydration lookups', () => {
    const plan = planBackfill({
      roster: ROSTER,
      now: () => new Date('2026-05-04T00:00:00Z'),
    });
    expect(plan.rosterByCik.get('0001336528')?.superinvestorTier).toBe('legendary');
    expect(plan.rosterByCik.get('0000000000')).toBeUndefined();
  });
});
