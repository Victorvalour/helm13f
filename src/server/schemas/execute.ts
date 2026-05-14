// E1-E5 — Execute methods.
// E1 / E2 are Tier 1 intelligence (mirror Q4 / Q6). They use the rich Query
// envelope so SDK consumers see the same evidence/freshness/confidence/meta.
// E3 / E4 / E5 are Tier 2 discovery / raw-data; lighter shape but root is
// always { type: "object" } and meta is always present.

import {
  Enums,
  Patterns,
  envelopeSchema,
  filerDeltaRowsSchema,
  tickerDeltaRowsSchema,
  superinvestorRowSchema,
  quarterRowSchema,
  filingHoldingRowSchema,
  cikSchema,
  accessionSchema,
  tickerSchema,
  quarterEndSchema,
  isoDateSchema,
  isoDateTimeSchema,
  sourceURLSchema,
} from './common.js';

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

// Discovery methods are cheap — 1/10 of intelligence pricing — and Query
// runtime should be willing to call them freely.
const discoveryMeta = (description: string) => ({
  surface: 'both' as const,
  queryEligible: true,
  latencyClass: 'instant' as const,
  pricing: { executeUsd: '0.0001' },
  rateLimit: {
    maxRequestsPerMinute: 1200,
    cooldownMs: 50,
    maxConcurrency: 20,
    supportsBulk: false,
    recommendedBatchTools: [],
    notes: description,
  },
});

// Lighter meta block for Execute-only raw responses (E3/E4/E5 outputs).
const lightMetaSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['asOf', 'truncated', 'totalRowsAvailable'],
  properties: {
    asOf: {
      ...isoDateTimeSchema,
      description:
        'Timestamp of the most recent successful ingestion run that informs this response.',
    },
    truncated: {
      type: 'boolean',
      description:
        'True iff results were truncated by an input limit. Honest signal of incompleteness.',
    },
    totalRowsAvailable: {
      type: 'integer',
      minimum: 0,
      description: 'Row count BEFORE truncation. Equals rows.length when truncated=false.',
    },
    limitApplied: {
      type: ['integer', 'null'],
      minimum: 1,
      description: 'The limit that was applied; null when no limit applies.',
    },
    notes: {
      type: ['string', 'null'],
      description: 'Optional free-form notes about coverage or freshness.',
    },
  },
} as const;

// =====================================================================
// E1 — get_filer_delta
// =====================================================================
export const E1 = {
  name: 'get_filer_delta',
  description:
    'Programmatic equivalent of Q4. Given a 10-digit padded CIK, returns full filer delta (newInitiations, exits, addedTo, trimmedFrom, unchanged) for a quarter pair. No fuzzy resolution — caller must supply CIK.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['filerCIK'],
    properties: {
      filerCIK: { ...cikSchema, default: '0001067983' },
      currentQuarter: {
        ...quarterEndSchema,
        description: 'Optional. Defaults to the most recent quarter the filer has filed for.',
      },
      priorQuarter: {
        ...quarterEndSchema,
        description: 'Optional. Defaults to the quarter immediately before currentQuarter.',
      },
      includeUnchanged: {
        type: 'boolean',
        default: false,
        description: 'Populate the unchanged sub-array. Default false.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        default: 1000,
        description: 'Maximum rows returned per sub-array. Default 1000.',
      },
    },
  },
  outputSchema: envelopeSchema(filerDeltaRowsSchema),
  _meta: intelligenceMeta('Filer dual-quarter delta keyed by CIK.'),
} as const;

// =====================================================================
// E2 — get_ticker_delta
// =====================================================================
export const E2 = {
  name: 'get_ticker_delta',
  description:
    'Programmatic equivalent of Q6. Given a ticker, returns the full delta picture across all parsed filers — bucketed by deltaType (newInitiations / exits / materialAdds / materialTrims).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ticker'],
    properties: {
      ticker: {
        ...tickerSchema,
        default: 'AAPL',
        description: 'US-listed ticker, uppercase, may include "." or "-".',
      },
      quarter: {
        ...quarterEndSchema,
        description: 'Optional. Defaults to most recent ingested quarter.',
      },
      minPctOfBookFilter: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Hide rows whose pctOfBook is below this threshold (decimal).',
      },
      includeNonSuperinvestors: {
        type: 'boolean',
        default: false,
        description: 'Include non-roster filers. Default false.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        default: 500,
        description: 'Maximum rows returned PER bucket. Default 500.',
      },
    },
  },
  outputSchema: envelopeSchema(tickerDeltaRowsSchema),
  _meta: intelligenceMeta('Ticker delta picture; bucketed by deltaType.'),
} as const;

// =====================================================================
// E3 — list_superinvestors
// =====================================================================
export const E3 = {
  name: 'list_superinvestors',
  description:
    'Discovery: returns the curated ~150 superinvestor roster with CIK, displayName, aliases, superinvestorTier, primaryStrategy, and pointer to last ingested filing. Optional tier or strategy filter.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      tier: {
        type: 'string',
        enum: [...Enums.superinvestorTier],
        description: "Filter by tier: 'legendary' | 'well-known' | 'notable'.",
      },
      strategy: {
        type: 'string',
        description:
          "Filter by primaryStrategy substring (case-insensitive). Example: 'value', 'event-driven'.",
      },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['rows', 'meta'],
    properties: {
      rows: {
        type: 'array',
        description:
          'Roster entries matching the optional filter. Sorted by superinvestorTier then displayName.',
        items: superinvestorRowSchema,
      },
      meta: lightMetaSchema,
    },
  },
  _meta: discoveryMeta('Curated superinvestor roster (~150 entries).'),
} as const;

// =====================================================================
// E4 — list_quarters_available
// =====================================================================
export const E4 = {
  name: 'list_quarters_available',
  description:
    "Discovery: returns the periodOfReport rows we have ingested, with per-quarter filersIngestedCount, season status, and earliest/latest filed_at dates. Optional filerCIK filter narrows to a single filer's history.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      filerCIK: {
        ...cikSchema,
        description:
          'Optional 10-digit padded CIK. When set, returns only quarters this filer has filed for.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['rows', 'meta'],
    properties: {
      rows: {
        type: 'array',
        description: 'One row per ingested periodOfReport, sorted by periodOfReport desc.',
        items: quarterRowSchema,
      },
      meta: lightMetaSchema,
    },
  },
  _meta: discoveryMeta('Time axis discovery; one row per ingested quarter.'),
} as const;

// =====================================================================
// E5 — get_filing
// =====================================================================
export const E5 = {
  name: 'get_filing',
  description:
    'Raw 13F: given an accession number, returns the parsed cover page (filer, periodOfReport, bookValueUSD, isAmendment, supersededByAccession) plus all aggregated holdings rows. Source URLs included for verification.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['accessionNumber'],
    properties: {
      accessionNumber: {
        ...accessionSchema,
        default: '0001193125-26-054580',
      },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'accessionNumber',
      'filerCIK',
      'filerName',
      'form',
      'isAmendment',
      'supersededByAccession',
      'periodOfReport',
      'filedAt',
      'bookValueUSD',
      'valueScale',
      'tableEntryTotal',
      'primaryDocURL',
      'infoTableURL',
      'holdings',
      'meta',
    ],
    properties: {
      accessionNumber: accessionSchema,
      filerCIK: cikSchema,
      filerName: {
        type: 'string',
        description: 'Canonical EDGAR filer name from the cover page.',
      },
      form: {
        type: 'string',
        enum: [...Enums.formType],
        description: "'13F-HR' or '13F-HR/A' (amendment).",
      },
      isAmendment: {
        type: 'boolean',
        description: 'True iff form is 13F-HR/A.',
      },
      supersededByAccession: {
        type: ['string', 'null'],
        pattern: Patterns.accession,
        description:
          'Accession of the amendment (13F-HR/A) that supersedes this filing, if any. Null when this is the active filing for its periodOfReport.',
      },
      periodOfReport: quarterEndSchema,
      filedAt: isoDateSchema,
      bookValueUSD: {
        type: 'integer',
        minimum: 0,
        description:
          'Total reported 13F book value in USD (cover-page tableValueTotal, normalised to dollars).',
      },
      valueScale: {
        type: 'string',
        enum: [...Enums.valueScale],
        description:
          "Source-regime scale of the underlying 13F values. 'USD' (post-2023-Q3) or 'USD_THOUSANDS' (pre-2023-Q3). bookValueUSD and per-holding valueUSD are normalised to dollars regardless.",
      },
      tableEntryTotal: {
        type: 'integer',
        minimum: 0,
        description:
          'Cover-page summaryPage.tableEntryTotal — count of raw <infoTable> rows in the InfoTable XML before our (cusip, putCall) aggregation. May exceed holdings.length.',
      },
      primaryDocURL: sourceURLSchema,
      infoTableURL: sourceURLSchema,
      holdings: {
        type: 'array',
        description:
          'Aggregated holdings rows (one per (cusip, putCall) within the filing). Sorted by pctOfBook desc.',
        items: filingHoldingRowSchema,
      },
      meta: lightMetaSchema,
    },
  },
  _meta: intelligenceMeta('Raw filing fetch by accession number.'),
} as const;

export const EXECUTE_TOOLS = [E1, E2, E3, E4, E5] as const;
