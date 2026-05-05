// FilerResolver tests against the curated superinvestors roster +
// the operator-mandated cases:
//   - "Burry" → Scion (CIK 0001649339)
//   - "Buffett" → Berkshire (CIK 0001067983)
//   - "Ackman" → Pershing Square (CIK 0001336528)
//   - Ambiguous "Capital" → top-3 candidates with confidence scores

import { describe, it, expect, beforeAll } from 'vitest';
import { FilerResolver, loadRoster, type RosterEntry } from '../../src/resolution/index.js';

let roster: RosterEntry[];
let resolver: FilerResolver;

beforeAll(async () => {
  roster = await loadRoster();
  resolver = new FilerResolver(roster);
});

describe('FilerResolver — direct CIK pass-through', () => {
  it('returns kind=cik for a 10-digit CIK input', () => {
    const out = resolver.resolve('0001067983');
    expect(out.kind).toBe('cik');
    if (out.kind === 'cik') expect(out.filerCIK).toBe('0001067983');
  });

  it('does not treat 9-digit numbers as CIKs', () => {
    const out = resolver.resolve('001067983');
    expect(out.kind).not.toBe('cik');
  });
});

describe('FilerResolver — operator-mandated cases', () => {
  it("'Burry' → Scion (CIK 0001649339)", () => {
    const out = resolver.resolve('Burry');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') {
      expect(out.filerCIK).toBe('0001649339');
      expect(out.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("'Buffett' → Berkshire (CIK 0001067983)", () => {
    const out = resolver.resolve('Buffett');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001067983');
  });

  it("'Ackman' → Pershing Square (CIK 0001336528)", () => {
    const out = resolver.resolve('Ackman');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001336528');
  });

  it("'Pershing' → Pershing Square (alias-token match)", () => {
    const out = resolver.resolve('Pershing');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001336528');
  });

  it("'Warren Buffett' → Berkshire (full alias)", () => {
    const out = resolver.resolve('Warren Buffett');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001067983');
  });

  it("'Berkshire Hathaway' → Berkshire (display-name direct)", () => {
    const out = resolver.resolve('Berkshire Hathaway');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001067983');
  });
});

describe('FilerResolver — ambiguity', () => {
  it("ambiguous 'Capital' returns top-3 candidates instead of a match", () => {
    // 'Capital' is a noise token (it's filtered) so the input becomes empty
    // after normalisation — this should NOT silently match anything.
    const out = resolver.resolve('Capital');
    expect(out.kind).toBe('ambiguous');
  });

  it("'Greenlight Capital Inc' resolves to Greenlight (suffix tokens are stripped)", () => {
    const out = resolver.resolve('Greenlight Capital Inc');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001079114');
  });

  it('a wildly unrelated input returns ambiguous (no match)', () => {
    const out = resolver.resolve('Tesla Motors Inc');
    expect(out.kind).toBe('ambiguous');
  });
});

describe('FilerResolver — synthetic edge cases', () => {
  it('handles short input "Loeb" → Third Point', () => {
    const out = resolver.resolve('Loeb');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001040273');
  });

  it("'Tepper' → Appaloosa", () => {
    const out = resolver.resolve('Tepper');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001656456');
  });

  it("'Klarman' → Baupost", () => {
    const out = resolver.resolve('Klarman');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001061768');
  });

  it("'Dalio' → Bridgewater", () => {
    const out = resolver.resolve('Dalio');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001350694');
  });

  it("'Pabrai' → Pabrai Funds (Dalal Street)", () => {
    const out = resolver.resolve('Pabrai');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001549575');
  });

  it('empty input returns ambiguous (no match)', () => {
    const out = resolver.resolve('');
    expect(out.kind).toBe('ambiguous');
  });

  it('whitespace-only input returns ambiguous (no match)', () => {
    const out = resolver.resolve('   ');
    expect(out.kind).toBe('ambiguous');
  });
});

describe('FilerResolver — minor typos', () => {
  it("'Berkshire Hathway' (typo) → Berkshire", () => {
    const out = resolver.resolve('Berkshire Hathway');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001067983');
  });

  it("'Aackman' (extra letter) → Pershing", () => {
    const out = resolver.resolve('Aackman');
    expect(out.kind).toBe('match');
    if (out.kind === 'match') expect(out.filerCIK).toBe('0001336528');
  });
});

describe('FilerResolver — empty roster degenerate case', () => {
  it('returns ambiguous (empty candidates) on any name input', () => {
    const r = new FilerResolver([]);
    const out = r.resolve('Buffett');
    expect(out).toEqual({ kind: 'ambiguous', candidates: [] });
  });

  it('still passes a CIK input through unchanged', () => {
    const r = new FilerResolver([]);
    const out = r.resolve('0001067983');
    expect(out).toEqual({ kind: 'cik', filerCIK: '0001067983' });
  });
});
