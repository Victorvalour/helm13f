// Helpers to build the rich Query envelope that every Query tool (and
// the two Tier-1 Execute methods) returns. Keeps the shape consistent
// across handlers and ensures every required field is populated.
//
// See docs/PRODUCT_CONTRACT.md §7 for the canonical envelope spec.

import type { ConvictionTier, ClusterTier } from '../../domain/index.js';

export type GapSignal =
  | 'fuzzy_match_below_threshold'
  | 'missing_prior_quarter_for_filer'
  | 'missing_current_quarter_for_filer'
  | 'cusip_unresolved'
  | 'amendment_pending';

export interface EnvelopeFreshness {
  asOf: string;
  currentQuarter: string | null;
  priorQuarter: string | null;
  lastIngestionRunAt: string;
  notes: string | null;
}

export interface EnvelopeMeta {
  coverageScope: 'long_us_equity';
  seasonStatus: 'complete' | 'in_progress' | 'between_seasons';
  filersIngestedCount: number;
  restatementApplied: boolean;
  valueScale: 'USD' | 'USD_THOUSANDS';
  truncated: boolean;
  totalRowsAvailable: number;
  limitApplied: number;
}

export interface EnvelopeConfidence {
  level: 'high' | 'moderate' | 'low';
  reasoning: string;
  factCount: number;
  gapSignals: GapSignal[];
}

export interface EnvelopeEvidenceFact {
  claim: string;
  filerCIK: string;
  accessionNumber: string;
  sourceURL: string;
  filedAt: string;
}

export interface EnvelopeEvidence {
  facts: EnvelopeEvidenceFact[];
  sourceRefs: string[];
  assumptions: string[];
  unknowns: string[];
}

export interface EnvelopeView {
  kind: 'table' | 'leaderboard' | 'timeseries' | 'summary';
  primaryColumn: string;
  weightColumn: string;
}

export interface EnvelopeSummaryStats {
  count: number;
  totalConvictionWeight: number;
  topByPctOfBookFilerCIK: string | null;
}

export interface ClusterSignal {
  detected: true;
  tier: ClusterTier;
  memberCount: number;
  memberCIKs: string[];
  strength: number;
}

export interface BuiltEnvelope<R> {
  summary: string;
  rows: R;
  summaryStats: EnvelopeSummaryStats;
  clusterSignal: ClusterSignal | null;
  evidence: EnvelopeEvidence;
  freshness: EnvelopeFreshness;
  confidence: EnvelopeConfidence;
  view: EnvelopeView;
  meta: EnvelopeMeta;
}

export interface BuildEnvelopeInput<R> {
  summary: string;
  rows: R;
  summaryStats: EnvelopeSummaryStats;
  clusterSignal?: ClusterSignal | null;
  evidence: EnvelopeEvidence;
  freshness: EnvelopeFreshness;
  confidence: EnvelopeConfidence;
  view: EnvelopeView;
  meta: EnvelopeMeta;
}

/** Standard ASSUMPTIONS string Helm13F surfaces on every envelope. */
export const ASSUMPTIONS_LONG_US_EQUITY =
  'Long US equity disclosures only; 13F-HR does not include short positions or 13D/13G holdings.';

export function buildEnvelope<R>(input: BuildEnvelopeInput<R>): BuiltEnvelope<R> {
  return {
    summary: input.summary,
    rows: input.rows,
    summaryStats: input.summaryStats,
    clusterSignal: input.clusterSignal ?? null,
    evidence: input.evidence,
    freshness: input.freshness,
    confidence: input.confidence,
    view: input.view,
    meta: input.meta,
  };
}

// Re-export so handler modules can import the conviction-tier type from one place.
export type { ConvictionTier };
