// Fuzzy filer name resolver.
//
// Strategy (per docs/PRODUCT_CONTRACT.md §10):
//   1. If input matches a 10-digit padded CIK pattern, return it verbatim
//      (no fuzzy work — caller specified an unambiguous identifier).
//   2. Otherwise, score every roster entry against the input using:
//      - Alias direct match (highest priority, score 1.0).
//      - Token-overlap ratio between normalised input tokens and the
//        normalised displayName/edgarName tokens.
//      - Levenshtein similarity over the full normalised forms.
//      Combined score = max(alias direct, 0.5*tokenOverlap + 0.5*levenshtein).
//   3. Top candidate above `minConfidence` (default 0.55) → 'match'.
//      Otherwise → 'ambiguous' with the top-N candidates and their scores.
//
// The roster is the single source of truth at construction; the resolver
// is pure (no I/O) so it's testable without DB.

import { similarity } from './levenshtein.js';

export type FilerResolution =
  | { kind: 'cik'; filerCIK: string }
  | { kind: 'match'; filerCIK: string; confidence: number; entry: RosterEntry }
  | { kind: 'ambiguous'; candidates: ResolverCandidate[] };

export interface ResolverCandidate {
  filerCIK: string;
  displayName: string;
  confidence: number;
}

export interface RosterEntry {
  cik: string;
  displayName: string;
  edgarName: string;
  aliases: string[];
  superinvestorTier?: 'legendary' | 'well-known' | 'notable';
  primaryStrategy?: string | null;
}

export interface FilerResolverOptions {
  /** Minimum combined score to count as a 'match'. Default 0.55. */
  minConfidence?: number;
  /** Number of candidates returned when ambiguous. Default 3. */
  topN?: number;
}

/** 10-digit padded CIK shape. */
const CIK_RE = /^[0-9]{10}$/;

export class FilerResolver {
  private readonly entries: ReadonlyArray<RosterEntry>;
  private readonly minConfidence: number;
  private readonly topN: number;

  /** Pre-normalised forms keyed parallel to `entries` for hot-path comparisons. */
  private readonly precomputed: ReadonlyArray<{
    displayNorm: string;
    edgarNorm: string;
    aliasNorms: string[];
    displayTokens: Set<string>;
    edgarTokens: Set<string>;
    aliasTokens: Set<string>[];
  }>;

  constructor(entries: ReadonlyArray<RosterEntry>, opts: FilerResolverOptions = {}) {
    this.entries = entries;
    this.minConfidence = opts.minConfidence ?? 0.55;
    this.topN = opts.topN ?? 3;
    this.precomputed = entries.map((e) => ({
      displayNorm: normalize(e.displayName),
      edgarNorm: normalize(e.edgarName),
      aliasNorms: e.aliases.map(normalize),
      displayTokens: new Set(tokenise(e.displayName)),
      edgarTokens: new Set(tokenise(e.edgarName)),
      aliasTokens: e.aliases.map((a) => new Set(tokenise(a))),
    }));
  }

  /**
   * Resolve an input that may be a 10-digit CIK or a fuzzy filer name.
   * Returns one of three result kinds; never throws on unmatched input.
   */
  resolve(input: string): FilerResolution {
    const trimmed = input.trim();
    if (CIK_RE.test(trimmed)) {
      return { kind: 'cik', filerCIK: trimmed };
    }
    if (this.entries.length === 0) {
      return { kind: 'ambiguous', candidates: [] };
    }
    const inputNorm = normalize(trimmed);
    const inputTokens = new Set(tokenise(trimmed));

    // Score every roster entry.
    const scored: Array<{
      entry: RosterEntry;
      score: number;
      aliasHit: boolean;
    }> = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const pre = this.precomputed[i]!;

      // Alias direct hit — highest priority.
      let aliasHit = false;
      let aliasScore = 0;
      for (const aliasNorm of pre.aliasNorms) {
        if (aliasNorm === inputNorm && inputNorm.length > 0) {
          aliasScore = 1;
          aliasHit = true;
          break;
        }
      }
      // Alias token-overlap + alias Levenshtein similarity. Token-overlap
      // catches "Warren" matching alias "Warren Buffett"; Levenshtein
      // catches single-character typos ("Aackman" → "Ackman").
      if (aliasScore < 1) {
        for (let j = 0; j < pre.aliasTokens.length; j++) {
          const at = pre.aliasTokens[j]!;
          const overlap = tokenOverlap(inputTokens, at);
          if (overlap > aliasScore) aliasScore = overlap;
          const aliasNorm = pre.aliasNorms[j]!;
          if (inputNorm.length > 0 && aliasNorm.length > 0) {
            const lev = similarity(inputNorm, aliasNorm);
            if (lev > aliasScore) aliasScore = lev;
          }
        }
      }

      // Display/edgar combined.
      const displayLev = similarity(inputNorm, pre.displayNorm);
      const edgarLev = similarity(inputNorm, pre.edgarNorm);
      const lev = Math.max(displayLev, edgarLev);
      const tok = Math.max(
        tokenOverlap(inputTokens, pre.displayTokens),
        tokenOverlap(inputTokens, pre.edgarTokens),
      );
      const main = 0.5 * lev + 0.5 * tok;

      const score = Math.max(aliasScore, main);
      if (score > 0) scored.push({ entry, score, aliasHit });
    }

    if (scored.length === 0) {
      return { kind: 'ambiguous', candidates: [] };
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored[0]!;
    const next = scored[1];

    // If the top score is above threshold AND clearly separated from the
    // runner-up (or it's an alias direct hit), accept it.
    const sep = next === undefined || top.score - next.score >= 0.1 || top.aliasHit;
    if (top.score >= this.minConfidence && sep) {
      return {
        kind: 'match',
        filerCIK: top.entry.cik,
        confidence: round4(top.score),
        entry: top.entry,
      };
    }

    return {
      kind: 'ambiguous',
      candidates: scored.slice(0, this.topN).map((s) => ({
        filerCIK: s.entry.cik,
        displayName: s.entry.displayName,
        confidence: round4(s.score),
      })),
    };
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

const SUFFIX_NOISE = new Set([
  'llc',
  'lp',
  'inc',
  'ltd',
  'corporation',
  'corp',
  'company',
  'co',
  'capital',
  'management',
  'mgmt',
  'partners',
  'fund',
  'funds',
  'group',
  'holdings',
  'holding',
  'asset',
  'investments',
  'investment',
  'advisors',
  'advisor',
  'global',
]);

/** Lower-case, punctuation-stripped, suffix-pruned, whitespace-collapsed. */
export function normalize(s: string): string {
  return tokenise(s).join(' ');
}

/** Lower-case + tokenise + strip corporate suffix tokens. */
export function tokenise(s: string): string[] {
  const cleaned = s
    .toLowerCase()
    .replace(/[.,'"`!?;:()&\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return [];
  return cleaned.split(' ').filter((t) => t.length > 0 && !SUFFIX_NOISE.has(t));
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  // Jaccard would penalise short queries against long names; use the
  // ratio over the smaller set so "Burry" matches "Burry Michael Scion".
  return inter / Math.min(a.size, b.size);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
