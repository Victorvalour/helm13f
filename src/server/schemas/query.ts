// Q1-Q6 — Query tools (Tier 1 intelligence). Each returns the rich
// envelope from common.ts with a tool-specific `rows` shape.
//
// `_meta.surface` uses 'both' to expose each tool on both Query and Execute
// surfaces. The Context docs use 'answer' / 'execute' / 'both' as the canonical
// enum; the example servers (and the registered runtime) accept 'both' as
// the dual-surface value, which is what we publish here.

import {
  envelopeSchema,
  filerDeltaRowsSchema,
  newInitiationRowSchema,
  exitRowSchema,
  resizeRowSchema,
  clusterEventRowSchema,
  tickerDeltaRowsSchema,
  rowsArraySchema,
  tickerSchema,
  quarterEndSchema,
  concentrationRowSchema,
  Enums,
} from './common.js';

// Reusable input fragments
const tickerInput = {
  ...tickerSchema,
  default: 'AAPL',
  description:
    'US-listed equity ticker (uppercase, may include "." or "-"). Resolved against company_tickers.json + cusip_ticker_map.',
};

const quarterInputOptional = {
  ...quarterEndSchema,
  description:
    'Optional periodOfReport ISO date. When omitted, the tool uses the most recent ingested quarter (see list_quarters_available).',
};

// Helper: standard _meta for an intelligence tool (Tier 1).
const intelligenceMeta = (description: string) => ({
  surface: 'both' as const,
  queryEligible: true,
  latencyClass: 'instant' as const,
  pricing: { executeUsd: '0.001' },
  rateLimit: {
    maxRequestsPerMinute: 600,
    cooldownMs: 100,
    maxConcurrency: 10,
    supportsBulk: false,
    recommendedBatchTools: [],
    notes: description,
  },
});

// =====================================================================
// Q1 — query_new_initiations_in_ticker
// =====================================================================
export const Q1 = {
  name: 'query_new_initiations_in_ticker',
  description:
    "Which institutional managers newly initiated a position in $TICKER in the most recent 13F filing season, weighted by % of each manager's reported 13F book? Rows sorted by pctOfBook descending. Scope: Helm13F v1 covers a curated 22-manager superinvestor universe — see list_superinvestors for the full roster.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ticker'],
    properties: {
      ticker: tickerInput,
      quarter: quarterInputOptional,
      minPctOfBook: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Minimum pctOfBook filter (decimal in [0,1]; e.g. 0.0025 = 0.25%). Default omitted = no minimum.',
        examples: [0.0025, 0.01],
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        default: 500,
        description:
          'Maximum rows returned. Default 500. Rows are sorted by pctOfBook desc, so a limit returns the most material movers first. meta.truncated and meta.totalRowsAvailable signal whether truncation occurred.',
      },
    },
  },
  outputSchema: envelopeSchema(
    rowsArraySchema(
      newInitiationRowSchema,
      'Filers who initiated this position last quarter, sorted by pctOfBook desc.',
    ),
  ),
  _meta: intelligenceMeta('One row per filer who initiated $TICKER last quarter.'),
} as const;

// =====================================================================
// Q2 — query_exits_from_ticker
// =====================================================================
export const Q2 = {
  name: 'query_exits_from_ticker',
  description:
    "Which institutional managers fully exited their $TICKER position in last quarter's 13Fs, and how meaningful was that position relative to their book the quarter before? Rows sorted by priorPctOfBook descending. Scope: Helm13F v1 covers a curated 22-manager superinvestor universe — see list_superinvestors for the full roster.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ticker'],
    properties: {
      ticker: tickerInput,
      quarter: quarterInputOptional,
      minPriorPctOfBook: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Minimum prior-quarter pctOfBook filter. Useful to surface only meaningful exits (e.g. 0.01 = exits of >=1%-of-book positions).',
        examples: [0.01],
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        default: 500,
        description: 'Maximum rows returned. Default 500. Sorted by priorPctOfBook desc.',
      },
    },
  },
  outputSchema: envelopeSchema(
    rowsArraySchema(exitRowSchema, 'Filers who exited this position last quarter.'),
  ),
  _meta: intelligenceMeta('One row per filer who exited $TICKER last quarter.'),
} as const;

// =====================================================================
// Q3 — query_material_resizes_in_ticker
// =====================================================================
export const Q3 = {
  name: 'query_material_resizes_in_ticker',
  description:
    "Material adds and trims in $TICKER for last quarter's 13Fs, where the change is at least minDeltaPct (default 25%) of the prior position size. Includes both adds and trims; deltaType discriminates. Sorted by |pctOfBookDelta| descending. Scope: Helm13F v1 covers a curated 22-manager superinvestor universe — see list_superinvestors for the full roster.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ticker'],
    properties: {
      ticker: tickerInput,
      quarter: quarterInputOptional,
      minDeltaPct: {
        type: 'number',
        minimum: 0,
        maximum: 10,
        default: 0.25,
        description:
          "Minimum |shareDeltaPct| to qualify as 'material' (decimal). Default 0.25 = 25%. Boundaries strict (currentShares > priorShares*(1+x)).",
      },
      direction: {
        type: 'string',
        enum: ['add', 'trim', 'both'],
        default: 'both',
        description: "Filter by deltaType: 'add' only, 'trim' only, or 'both'.",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        default: 500,
        description: 'Maximum rows returned. Default 500. Sorted by |pctOfBookDelta| desc.',
      },
    },
  },
  outputSchema: envelopeSchema(
    rowsArraySchema(resizeRowSchema, 'Filers who materially resized this position.'),
  ),
  _meta: intelligenceMeta('One row per filer who materially resized $TICKER (≥25% by default).'),
} as const;

// =====================================================================
// Q4 — query_filer_quarter_delta
// =====================================================================
export const Q4 = {
  name: 'query_filer_quarter_delta',
  description:
    "What did $MANAGER's fund change between two quarters? Accepts a CIK ('0001067983') or fuzzy name ('Burry', 'Buffett', 'Ackman'). Returns five sub-arrays: newInitiations, exits, addedTo, trimmedFrom, and (optionally) unchanged. If the fuzzy match confidence is below threshold, returns isError=true with errorCode='ambiguous_filer' and a candidates list. Scope: Helm13F v1 covers a curated 22-manager superinvestor universe — see list_superinvestors. Filers outside the roster aren't ingested in v1.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['filerNameOrCIK'],
    properties: {
      filerNameOrCIK: {
        type: 'string',
        default: '0001067983',
        description:
          "Either a 10-digit zero-padded CIK ('0001067983') or a fuzzy filer name ('Burry', 'Berkshire Hathaway'). The resolver checks the curated roster first, then falls back to fuzzy search.",
        examples: ['0001067983', 'Burry', 'Pershing'],
      },
      currentQuarter: {
        ...quarterEndSchema,
        description:
          'Optional periodOfReport for the current side of the delta. Default: most recent quarter the filer has filed for.',
      },
      priorQuarter: {
        ...quarterEndSchema,
        description:
          'Optional periodOfReport for the prior side of the delta. Default: the calendar quarter immediately before currentQuarter.',
      },
      includeUnchanged: {
        type: 'boolean',
        default: false,
        description:
          "When true, populates the 'unchanged' sub-array (compact rows). Default false to keep payloads lean.",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        default: 1000,
        description:
          'Maximum rows returned PER sub-array (newInitiations / exits / addedTo / trimmedFrom / unchanged). Default 1000.',
      },
    },
  },
  outputSchema: envelopeSchema(filerDeltaRowsSchema),
  _meta: intelligenceMeta(
    'Single-filer dual-quarter delta. Rows is a 5-bucket object, not a flat array.',
  ),
} as const;

// =====================================================================
// Q5 — query_superinvestor_cluster_on_ticker
// =====================================================================
//
// Q5 ships its own row shape (ClusterEventRow, calibration 7) rather than
// reusing the Q1 newInitiationRowSchema, because cluster members may be
// either 'new' or 'add' events and forcing 'add' members into a sharesNew
// field is semantically lossy. The envelope-level invariant
// clusterSignal.strength === sum(rows[i].pctOfBookDelta) is enforced in the
// query handler and asserted in the contract test suite.
export const Q5 = {
  name: 'query_superinvestor_cluster_on_ticker',
  description:
    "Did a cluster of well-known managers cluster-buy $TICKER in last quarter's 13Fs? Returns the cluster signal (tier weak/notable/strong, member count, combined book-weight strength) plus per-member rows distinguishing new initiations from material adds. A cluster requires 3+ superinvestors with new or add events on the ticker. Scope: Helm13F v1 covers a curated 22-manager superinvestor universe — see list_superinvestors for the full roster.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ticker'],
    properties: {
      ticker: tickerInput,
      quarter: quarterInputOptional,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        default: 500,
        description:
          'Maximum cluster-member rows returned. Cluster is naturally bounded by the curated roster (~150) so truncation is rare; this is for shape consistency.',
      },
    },
  },
  outputSchema: envelopeSchema(
    rowsArraySchema(
      clusterEventRowSchema,
      "Cluster-member rows. Each row's clusterEventType discriminates 'new' vs 'add'; sharesAttributed is the increment attributed to the cluster event (full position for 'new'; currentShares - priorShares for 'add'). Sum of rows[].pctOfBookDelta MUST equal clusterSignal.strength.",
    ),
  ),
  _meta: intelligenceMeta('Cluster detection across the curated superinvestor roster.'),
} as const;

// =====================================================================
// Q6 — query_full_ticker_delta_picture
// =====================================================================
export const Q6 = {
  name: 'query_full_ticker_delta_picture',
  description:
    'Full delta picture on $TICKER for last quarter — new buys, exits, big adds, big trims, all weighted by conviction. Composite of Q1+Q2+Q3 in one structured envelope. Rows are bucketed by deltaType. Scope: Helm13F v1 covers a curated 22-manager superinvestor universe — see list_superinvestors for the full roster.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ticker'],
    properties: {
      ticker: tickerInput,
      quarter: quarterInputOptional,
      minPctOfBook: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Minimum pctOfBook filter for newInitiations and materialAdds; minimum priorPctOfBook for exits and materialTrims.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        default: 500,
        description:
          'Maximum rows returned PER bucket (newInitiations / exits / materialAdds / materialTrims). Default 500.',
      },
    },
  },
  outputSchema: envelopeSchema(tickerDeltaRowsSchema),
  _meta: intelligenceMeta('Composite ticker delta. Rows is a 4-bucket object, not a flat array.'),
} as const;

// =====================================================================
// Q7 — query_concentrated_portfolios
// =====================================================================
// Composes list_superinvestors + per-filer holdings ranking server-side so a
// single tool call returns the concentration ranking that prosumers use to
// clone-invest the most conviction-driven managers. Without this, the Query
// runtime has to chain list_superinvestors → get_filer_delta × N which it
// generally won't compose unprompted.
export const Q7 = {
  name: 'query_concentrated_portfolios',
  description:
    'Which superinvestors run the most concentrated portfolios for a given quarter? Returns one row per filer with their book value, holding count, top-position pctOfBook, and the single largest holding. Sort: topPositionPctOfBook descending (most conviction-driven first), then holdingCount ascending (fewer positions = more concentrated). Free LLMs cannot answer because they can neither enumerate the curated roster nor compute live per-filer concentration. Scope: Helm13F v1 covers a curated 22-manager superinvestor universe — see list_superinvestors for the full roster.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      quarter: quarterInputOptional,
      tier: {
        type: 'string',
        enum: [...Enums.superinvestorTier],
        description:
          "Optional filter to a single roster tier: 'legendary' | 'well-known' | 'notable'. When omitted, ranks across the full curated roster.",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 25,
        description: 'Maximum rows returned. Default 25. Rows are pre-sorted by concentration.',
      },
    },
  },
  outputSchema: envelopeSchema(
    rowsArraySchema(
      concentrationRowSchema,
      'Per-filer concentration snapshot rows. Sorted by topPositionPctOfBook desc, then holdingCount asc.',
    ),
  ),
  _meta: intelligenceMeta(
    'Concentration ranking across the curated superinvestor roster. Single call composes the cross-filer aggregation server-side.',
  ),
} as const;

export const QUERY_TOOLS = [Q1, Q2, Q3, Q4, Q5, Q6, Q7] as const;
