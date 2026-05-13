// Helm13F — JSON Schema building blocks shared across all 11 tools.
//
// Conventions enforced here (see docs/PRODUCT_CONTRACT.md §8):
//   - camelCase property names.
//   - Every property carries a description with units / range / example.
//   - Every array declares full items.properties; never bare { type: "array" }.
//   - Root of every published outputSchema is { type: "object" }.
//   - No JSON-Schema if/then conditionals (Context runtime validator's
//     support is unverified; we keep schemas portable). The
//     `isSuperinvestor ↔ superinvestorTier` invariant is documented in
//     property descriptions, enforced in the parser/loader (Phase 3),
//     and asserted in contract tests.

export const Patterns = {
  // 10-digit zero-padded CIK, per data.sec.gov submissions endpoint convention.
  cik: '^[0-9]{10}$',
  // SEC accession number with dashes: "0001193125-26-054580" (10-2-6).
  accession: '^[0-9]{10}-[0-9]{2}-[0-9]{6}$',
  // CUSIP: 9 uppercase alphanumeric characters.
  cusip: '^[0-9A-Z]{9}$',
  // ISO calendar date: "YYYY-MM-DD".
  isoDate: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
  // Quarter-end (periodOfReport) ISO date.
  // Pattern matches MM-DD endings of -03-31, -06-30, -09-30, -12-31.
  // Kept loose: the full constraint is enforced in code; the schema rejects
  // obvious garbage but doesn't reject e.g. -02-29.
  isoQuarterEnd: '^[0-9]{4}-(03-31|06-30|09-30|12-31)$',
  // ISO 8601 datetime with offset.
  isoDateTime:
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$',
  // Ticker: 1-16 chars, uppercase letters, digits, dot, hyphen
  // (e.g. "BRK-B", "BF.B"). Permissive on purpose.
  ticker: '^[A-Z0-9.\\-]{1,16}$',
} as const;

export const Enums = {
  convictionTier: ['core', 'meaningful', 'starter', 'scout'] as const,
  deltaType: ['new', 'exit', 'add', 'trim', 'unchanged'] as const,
  superinvestorTier: ['legendary', 'well-known', 'notable'] as const,
  clusterTier: ['weak', 'notable', 'strong'] as const,
  valueScale: ['USD', 'USD_THOUSANDS'] as const,
  seasonStatus: ['complete', 'in_progress', 'between_seasons'] as const,
  confidenceLevel: ['high', 'moderate', 'low'] as const,
  viewKind: ['table', 'leaderboard', 'timeseries', 'summary'] as const,
  // Closed taxonomy of gap signals (calibration 2). Machine-discriminable.
  gapSignal: [
    'fuzzy_match_below_threshold',
    'missing_prior_quarter_for_filer',
    'missing_current_quarter_for_filer',
    'cusip_unresolved',
    'amendment_pending',
  ] as const,
  errorCode: [
    'ambiguous_filer',
    'unknown_filer',
    'unknown_ticker',
    'no_data_for_quarter',
    'not_in_scope',
    'invalid_input',
  ] as const,
  putCall: ['Put', 'Call'] as const,
  sshPrnamtType: ['SH', 'PRN'] as const,
  superinvestorTierFilter: ['legendary', 'well-known', 'notable'] as const,
  formType: ['13F-HR', '13F-HR/A'] as const,
  cusipMapSource: ['company_tickers', 'openfigi', 'manual_override'] as const,
} as const;

// ---------- Reusable scalar schema fragments ----------

export const cikSchema = {
  type: 'string',
  pattern: Patterns.cik,
  description:
    "10-digit zero-padded SEC Central Index Key, per data.sec.gov convention. Example: '0001067983' (Berkshire Hathaway).",
  examples: ['0001067983', '0001649339'],
} as const;

export const accessionSchema = {
  type: 'string',
  pattern: Patterns.accession,
  description: "SEC filing accession number with dashes (10-2-6). Example: '0001193125-26-054580'.",
  examples: ['0001193125-26-054580'],
} as const;

export const cusipSchema = {
  type: 'string',
  pattern: Patterns.cusip,
  description: "9-character uppercase alphanumeric CUSIP. Example: '037833100' (Apple Inc.).",
  examples: ['037833100', '02005N100'],
} as const;

export const tickerSchema = {
  type: 'string',
  pattern: Patterns.ticker,
  description:
    "US-listed equity ticker, uppercase, 1-16 chars, may include '.' or '-' for share classes (e.g. 'BRK-B', 'BF.B').",
  examples: ['AAPL', 'BRK-B', 'POOL'],
} as const;

export const tickerOrNullSchema = {
  type: ['string', 'null'],
  pattern: Patterns.ticker,
  description:
    "US-listed equity ticker or null when CUSIP cannot be resolved to a ticker. See gapSignals='cusip_unresolved'.",
  examples: ['AAPL', null],
} as const;

export const quarterEndSchema = {
  type: 'string',
  pattern: Patterns.isoQuarterEnd,
  description:
    "ISO date of the 13F periodOfReport (always a calendar quarter-end: -03-31, -06-30, -09-30, -12-31). Example: '2025-12-31'.",
  examples: ['2025-12-31', '2025-09-30'],
} as const;

export const isoDateSchema = {
  type: 'string',
  pattern: Patterns.isoDate,
  description: "ISO calendar date 'YYYY-MM-DD'.",
  examples: ['2026-02-17'],
} as const;

export const isoDateTimeSchema = {
  type: 'string',
  pattern: Patterns.isoDateTime,
  description: "ISO 8601 datetime with timezone offset (or 'Z' for UTC).",
  examples: ['2026-05-03T03:14:00Z'],
} as const;

export const pctOfBookSchema = {
  type: 'number',
  minimum: 0,
  maximum: 1,
  description:
    "Fraction of the filer's 13F book attributable to this position. Decimal in [0, 1] with up to 4 decimal places (5% = 0.0500). NOT a percentage; synthesisers format as % at the prose layer.",
  examples: [0.0018, 0.0432, 0.12],
} as const;

export const sourceURLSchema = {
  type: 'string',
  format: 'uri',
  description:
    'Full SEC EDGAR URL pointing to the source XML for this fact (cover page or InfoTable). Always under https://www.sec.gov/Archives/edgar/data/...',
  examples: ['https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml'],
} as const;

// ---------- Common composite fragments ----------

// Fields identifying who the filer is (used inside row schemas).
// Invariant: isSuperinvestor=false ↔ superinvestorTier=null.
// Documented in superinvestorTier.description; enforced in parser + tests.
const filerIdentityProps = {
  filerCIK: cikSchema,
  filerName: {
    type: 'string',
    description:
      "Canonical EDGAR filer name as it appears in the cover page (filingManager.name). Example: 'BERKSHIRE HATHAWAY INC'.",
    examples: ['BERKSHIRE HATHAWAY INC'],
  },
  filerDisplayName: {
    type: ['string', 'null'],
    description:
      "Friendlier display name from our roster (superinvestors.json). Null when the filer is not in the curated roster. Example: 'Berkshire Hathaway'.",
    examples: ['Berkshire Hathaway', null],
  },
  isSuperinvestor: {
    type: 'boolean',
    description:
      'True iff the filer is in the curated superinvestor roster. Invariant: when false, superinvestorTier MUST be null.',
  },
  superinvestorTier: {
    type: ['string', 'null'],
    enum: [...Enums.superinvestorTier, null],
    description:
      "Curated tier from superinvestors.json: 'legendary' | 'well-known' | 'notable'. MUST be null when isSuperinvestor=false. Always paired; never desynchronised.",
    examples: ['legendary', null],
  },
  primaryStrategy: {
    type: ['string', 'null'],
    description:
      "Roster-curated strategy hint, e.g. 'value', 'growth', 'event-driven', 'macro'. Null when not in roster.",
    examples: ['value', 'event-driven', null],
  },
} as const;

// Fields identifying the held instrument.
const issuerIdentityProps = {
  ticker: tickerOrNullSchema,
  issuerName: {
    type: 'string',
    description:
      "Issuer name as reported in the 13F INFOTABLE row (nameOfIssuer). Example: 'POOL CORP'.",
    examples: ['POOL CORP', 'APPLE INC'],
  },
  cusip: cusipSchema,
} as const;

// Common provenance fields on every row.
const provenanceProps = {
  filedAt: {
    ...isoDateSchema,
    description:
      "Date the source 13F was filed (filing_date in EDGAR submissions). ISO 'YYYY-MM-DD'.",
  },
  sourceURL: sourceURLSchema,
} as const;

// ---------- Per-tool ROW schemas ----------

// Q1 / Q5: a "new initiation" row.
export const newInitiationRowSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'filerCIK',
    'filerName',
    'filerDisplayName',
    'isSuperinvestor',
    'superinvestorTier',
    'primaryStrategy',
    'ticker',
    'issuerName',
    'cusip',
    'sharesNew',
    'valueUSD',
    'pctOfBook',
    'convictionTier',
    'bookValueUSD',
    'currentQuarterAccessionNumber',
    'sourceURL',
    'filedAt',
  ],
  properties: {
    ...filerIdentityProps,
    ...issuerIdentityProps,
    sharesNew: {
      type: 'integer',
      minimum: 0,
      description:
        'Total shares (or principal amount, when sshPrnamtType=PRN) initiated this quarter. Aggregated across multi-row entries for the same (cusip, putCall) within the filing.',
      examples: [404057],
    },
    valueUSD: {
      type: 'integer',
      minimum: 0,
      description:
        "Reported market value of the position in USD (post-2023 EDGAR regime). When valueScale='USD_THOUSANDS' (pre-Sept 2023), this field is normalised to dollars by the parser; meta.valueScale records the source regime.",
      examples: [122334566],
    },
    pctOfBook: pctOfBookSchema,
    convictionTier: {
      type: 'string',
      enum: [...Enums.convictionTier],
      description:
        'Deterministic tier from pctOfBook: core (>=5%), meaningful (1-5%), starter (0.25-1%), scout (<0.25%). Boundaries: exactly 0.01->meaningful, exactly 0.05->core.',
    },
    bookValueUSD: {
      type: 'integer',
      minimum: 0,
      description:
        "Filer's total reported 13F book value (USD) for the current quarter (cover-page tableValueTotal, normalised to dollars).",
      examples: [274160086701],
    },
    currentQuarterAccessionNumber: accessionSchema,
    ...provenanceProps,
  },
} as const;

// Q2: an "exit" row. Same as Q1 but tracks the *prior*-quarter conviction.
export const exitRowSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'filerCIK',
    'filerName',
    'filerDisplayName',
    'isSuperinvestor',
    'superinvestorTier',
    'primaryStrategy',
    'ticker',
    'issuerName',
    'cusip',
    'sharesExited',
    'priorValueUSD',
    'priorPctOfBook',
    'priorConvictionTier',
    'priorBookValueUSD',
    'priorQuarterAccessionNumber',
    'currentQuarterAccessionNumber',
    'sourceURL',
    'filedAt',
  ],
  properties: {
    ...filerIdentityProps,
    ...issuerIdentityProps,
    sharesExited: {
      type: 'integer',
      minimum: 0,
      description:
        'Shares (or principal amount) the filer held the prior quarter and no longer holds.',
      examples: [1000000],
    },
    priorValueUSD: {
      type: 'integer',
      minimum: 0,
      description: 'Market value (USD) of the exited position the quarter before exit.',
    },
    priorPctOfBook: {
      ...pctOfBookSchema,
      description:
        'Conviction (pctOfBook) of the position the quarter BEFORE exit. Decimal in [0, 1].',
    },
    priorConvictionTier: {
      type: 'string',
      enum: [...Enums.convictionTier],
      description: 'Conviction tier of the position the quarter BEFORE exit.',
    },
    priorBookValueUSD: {
      type: 'integer',
      minimum: 0,
      description: "Filer's reported book value (USD) the quarter BEFORE exit.",
    },
    priorQuarterAccessionNumber: accessionSchema,
    currentQuarterAccessionNumber: {
      ...accessionSchema,
      description:
        'Accession of the current-quarter filing where the position is now absent. References the filing whose absence proves the exit.',
    },
    ...provenanceProps,
  },
} as const;

// Q3: a "material resize" row.
export const resizeRowSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'filerCIK',
    'filerName',
    'filerDisplayName',
    'isSuperinvestor',
    'superinvestorTier',
    'primaryStrategy',
    'ticker',
    'issuerName',
    'cusip',
    'deltaType',
    'priorShares',
    'currentShares',
    'shareDeltaPct',
    'priorPctOfBook',
    'currentPctOfBook',
    'pctOfBookDelta',
    'priorBookValueUSD',
    'currentBookValueUSD',
    'priorQuarterAccessionNumber',
    'currentQuarterAccessionNumber',
    'sourceURL',
    'filedAt',
  ],
  properties: {
    ...filerIdentityProps,
    ...issuerIdentityProps,
    deltaType: {
      type: 'string',
      enum: ['add', 'trim'],
      description:
        "Material resize type. 'add' if currentShares > priorShares*1.25; 'trim' if currentShares < priorShares*0.75. Boundaries strictly excluded -> 'unchanged' (which never appears in resize results).",
    },
    priorShares: {
      type: 'integer',
      minimum: 0,
      description: 'Aggregated shares (or principal amount) held the prior quarter.',
    },
    currentShares: {
      type: 'integer',
      minimum: 0,
      description: 'Aggregated shares (or principal amount) held the current quarter.',
    },
    shareDeltaPct: {
      type: 'number',
      description:
        '(currentShares - priorShares) / priorShares as a decimal. Positive for add, negative for trim. Example: 0.50 = +50%.',
      examples: [0.5, -0.4],
    },
    priorPctOfBook: pctOfBookSchema,
    currentPctOfBook: pctOfBookSchema,
    pctOfBookDelta: {
      type: 'number',
      minimum: -1,
      maximum: 1,
      description:
        '(currentPctOfBook - priorPctOfBook) as a decimal. Positive when conviction grew. Example: 0.0022 = +0.22pp of book.',
      examples: [0.0022, -0.001],
    },
    priorBookValueUSD: {
      type: 'integer',
      minimum: 0,
      description: 'Filer book value the prior quarter (USD).',
    },
    currentBookValueUSD: {
      type: 'integer',
      minimum: 0,
      description: 'Filer book value the current quarter (USD).',
    },
    priorQuarterAccessionNumber: accessionSchema,
    currentQuarterAccessionNumber: accessionSchema,
    ...provenanceProps,
  },
} as const;

// Q5 cluster-event row (calibration 7).
//
// A semantically distinct row shape for cluster members, supporting both
// "new" initiations and "add"-type cluster events without forcing add-events
// into a sharesNew field.
//
// Invariants (enforced in parser/loader; documented here):
//   - clusterEventType="new"  ↔  priorPctOfBook IS NULL  ↔  priorQuarterAccessionNumber IS NULL
//   - clusterEventType="add"  ↔  priorPctOfBook is a number AND priorQuarterAccessionNumber is set
//   - pctOfBookDelta === currentPctOfBook - (priorPctOfBook ?? 0)
//   - clusterSignal.strength === sum_over_rows(pctOfBookDelta)  (envelope-level)
export const clusterEventRowSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'filerCIK',
    'filerName',
    'filerDisplayName',
    'isSuperinvestor',
    'superinvestorTier',
    'primaryStrategy',
    'ticker',
    'issuerName',
    'cusip',
    'convictionTier',
    'clusterEventType',
    'sharesAttributed',
    'priorPctOfBook',
    'currentPctOfBook',
    'pctOfBookDelta',
    'priorQuarterAccessionNumber',
    'currentQuarterAccessionNumber',
    'sourceURL',
    'filedAt',
  ],
  properties: {
    ...filerIdentityProps,
    ...issuerIdentityProps,
    convictionTier: {
      type: 'string',
      enum: [...Enums.convictionTier],
      description:
        "Filer's CURRENT-quarter conviction tier on this position (post-event). Derived from currentPctOfBook.",
    },
    clusterEventType: {
      type: 'string',
      enum: ['new', 'add'],
      description:
        "'new' if this is a fresh initiation; 'add' if the filer increased an existing position by ≥25% (qualifying as a material add).",
    },
    sharesAttributed: {
      type: 'integer',
      minimum: 0,
      description:
        "Shares (or principal amount) attributable to the cluster event. For 'new', this is the full new position size (= currentShares). For 'add', this is currentShares - priorShares (the increase).",
      examples: [404057, 250000],
    },
    priorPctOfBook: {
      type: ['number', 'null'],
      minimum: 0,
      maximum: 1,
      description:
        "Prior-quarter conviction (decimal in [0, 1]). NULL when clusterEventType='new'. Required when clusterEventType='add'.",
      examples: [null, 0.0028],
    },
    currentPctOfBook: pctOfBookSchema,
    pctOfBookDelta: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'currentPctOfBook - (priorPctOfBook ?? 0). Always non-negative for cluster events (cluster includes only new/add). Decimal; example 0.0022 ≈ +0.22pp of book. Aggregated across rows it must equal clusterSignal.strength (envelope-level invariant).',
      examples: [0.0018, 0.005, 0.025],
    },
    priorQuarterAccessionNumber: {
      type: ['string', 'null'],
      pattern: Patterns.accession,
      description:
        "Prior-quarter accession number. NULL when clusterEventType='new'. Required when clusterEventType='add' (proves the prior-quarter baseline).",
    },
    currentQuarterAccessionNumber: accessionSchema,
    ...provenanceProps,
  },
} as const;

// Q4 / E1 unchanged-row: lighter shape (no per-row provenance).
export const unchangedRowSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['cusip', 'ticker', 'issuerName', 'currentShares', 'currentPctOfBook'],
  properties: {
    cusip: cusipSchema,
    ticker: tickerOrNullSchema,
    issuerName: {
      type: 'string',
      description: 'Issuer name from the INFOTABLE row.',
    },
    currentShares: {
      type: 'integer',
      minimum: 0,
      description: 'Aggregated shares (or principal amount) held the current quarter.',
    },
    currentPctOfBook: pctOfBookSchema,
  },
} as const;

// Q4 / E1 envelope.rows shape: filer-axis delta with five sub-arrays.
export const filerDeltaRowsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'filerCIK',
    'filerName',
    'filerDisplayName',
    'currentQuarter',
    'priorQuarter',
    'currentBookValueUSD',
    'priorBookValueUSD',
    'newInitiations',
    'exits',
    'addedTo',
    'trimmedFrom',
    'unchanged',
  ],
  properties: {
    filerCIK: cikSchema,
    filerName: {
      type: 'string',
      description: 'Canonical EDGAR filer name.',
    },
    filerDisplayName: {
      type: ['string', 'null'],
      description:
        'Friendlier display name from roster, or null when filer is not in the curated roster.',
    },
    currentQuarter: quarterEndSchema,
    priorQuarter: quarterEndSchema,
    currentBookValueUSD: {
      type: 'integer',
      minimum: 0,
      description: 'Total reported 13F book value (USD) for the current quarter.',
    },
    priorBookValueUSD: {
      type: 'integer',
      minimum: 0,
      description: 'Total reported 13F book value (USD) for the prior quarter.',
    },
    newInitiations: {
      type: 'array',
      description:
        'Positions present in current quarter but not in prior. Sorted by pctOfBook desc.',
      items: newInitiationRowSchema,
    },
    exits: {
      type: 'array',
      description:
        'Positions present in prior quarter but not in current. Sorted by priorPctOfBook desc.',
      items: exitRowSchema,
    },
    addedTo: {
      type: 'array',
      description:
        'Positions where currentShares > priorShares*1.25. Sorted by currentPctOfBook desc.',
      items: resizeRowSchema,
    },
    trimmedFrom: {
      type: 'array',
      description:
        'Positions where currentShares < priorShares*0.75. Sorted by priorPctOfBook desc.',
      items: resizeRowSchema,
    },
    unchanged: {
      type: 'array',
      description:
        'Positions held with shares within ±25% of the prior quarter. Compact shape (no provenance fields). Included only when input.includeUnchanged=true.',
      items: unchangedRowSchema,
    },
  },
} as const;

// Q6 / E2 envelope.rows shape: ticker-axis delta with four buckets.
export const tickerDeltaRowsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'ticker',
    'issuerName',
    'cusip',
    'currentQuarter',
    'priorQuarter',
    'newInitiations',
    'exits',
    'materialAdds',
    'materialTrims',
  ],
  properties: {
    ticker: tickerSchema,
    issuerName: {
      type: ['string', 'null'],
      description:
        'Issuer name from any current-quarter holding row for this CUSIP. Null when no rows match (unknown ticker or no superinvestor activity this quarter).',
    },
    cusip: {
      type: ['string', 'null'],
      pattern: Patterns.cusip,
      description:
        '9-character uppercase alphanumeric CUSIP from any current-quarter holding row. Null when no rows match.',
    },
    currentQuarter: quarterEndSchema,
    priorQuarter: quarterEndSchema,
    newInitiations: {
      type: 'array',
      description: 'Filers who newly initiated this position last quarter.',
      items: newInitiationRowSchema,
    },
    exits: {
      type: 'array',
      description: 'Filers who fully exited this position last quarter.',
      items: exitRowSchema,
    },
    materialAdds: {
      type: 'array',
      description: 'Filers who increased their position by ≥25% (deltaType="add").',
      items: resizeRowSchema,
    },
    materialTrims: {
      type: 'array',
      description: 'Filers who decreased their position by ≥25% (deltaType="trim").',
      items: resizeRowSchema,
    },
  },
} as const;

// E3 row: a superinvestor roster entry.
export const superinvestorRowSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'filerCIK',
    'displayName',
    'edgarName',
    'aliases',
    'superinvestorTier',
    'primaryStrategy',
    'lastFilingPeriodOfReport',
    'lastFilingAccessionNumber',
  ],
  properties: {
    filerCIK: cikSchema,
    displayName: {
      type: 'string',
      description: "Friendly display name (e.g. 'Berkshire Hathaway').",
    },
    edgarName: {
      type: 'string',
      description: 'Canonical EDGAR filer name.',
    },
    aliases: {
      type: 'array',
      description: 'Names and nicknames the fuzzy resolver should accept for this filer.',
      items: {
        type: 'string',
        description: "Alias string, e.g. 'Buffett' or 'Warren Buffett'.",
      },
    },
    superinvestorTier: {
      type: 'string',
      enum: [...Enums.superinvestorTier],
      description: "'legendary' | 'well-known' | 'notable'.",
    },
    primaryStrategy: {
      type: ['string', 'null'],
      description: "Strategy hint, e.g. 'value', 'event-driven'. Null when unknown.",
    },
    lastFilingPeriodOfReport: {
      type: ['string', 'null'],
      pattern: Patterns.isoQuarterEnd,
      description:
        'periodOfReport of the most recent 13F-HR we have ingested for this filer. Null if none ingested yet.',
    },
    lastFilingAccessionNumber: {
      type: ['string', 'null'],
      pattern: Patterns.accession,
      description:
        'Accession of the most recent 13F-HR we have ingested for this filer. Null if none ingested yet.',
    },
  },
} as const;

// E4 row: a quarter-availability entry.
export const quarterRowSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'periodOfReport',
    'filersIngestedCount',
    'isCurrentSeason',
    'seasonStatus',
    'earliestFiledAt',
    'latestFiledAt',
  ],
  properties: {
    periodOfReport: quarterEndSchema,
    filersIngestedCount: {
      type: 'integer',
      minimum: 0,
      description: 'Distinct filers we have parsed for this periodOfReport.',
    },
    isCurrentSeason: {
      type: 'boolean',
      description:
        'True iff this is the most recent quarter and we are still inside its 45-day filing window.',
    },
    seasonStatus: {
      type: 'string',
      enum: [...Enums.seasonStatus],
      description:
        "'complete' if all known filers have filed; 'in_progress' during the filing window; 'between_seasons' off-season.",
    },
    earliestFiledAt: {
      ...isoDateSchema,
      description: 'Earliest filed_at date observed for this periodOfReport.',
    },
    latestFiledAt: {
      ...isoDateSchema,
      description: 'Latest filed_at date observed for this periodOfReport.',
    },
  },
} as const;

// E5 holding row (lighter than INFOTABLE; one row per (cusip, putCall) post-aggregation).
export const filingHoldingRowSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'ticker',
    'issuerName',
    'cusip',
    'titleOfClass',
    'shares',
    'valueUSD',
    'sshPrnamtType',
    'putCall',
    'pctOfBook',
    'convictionTier',
  ],
  properties: {
    ticker: tickerOrNullSchema,
    issuerName: {
      type: 'string',
      description: 'Issuer name from the INFOTABLE row.',
    },
    cusip: cusipSchema,
    titleOfClass: {
      type: 'string',
      description: "Class of security from INFOTABLE titleOfClass, e.g. 'COM', 'CL A'.",
    },
    shares: {
      type: 'integer',
      minimum: 0,
      description:
        'Aggregated shares (or principal amount, when sshPrnamtType=PRN) for this (cusip, putCall) within the filing.',
    },
    valueUSD: {
      type: 'integer',
      minimum: 0,
      description: 'Aggregated reported market value in USD for this (cusip, putCall).',
    },
    sshPrnamtType: {
      type: 'string',
      enum: [...Enums.sshPrnamtType],
      description: "'SH' for share count; 'PRN' for principal amount in dollars.",
    },
    putCall: {
      type: ['string', 'null'],
      enum: [...Enums.putCall, null],
      description: "'Put' or 'Call' if the holding is an option; null for the underlying equity.",
    },
    pctOfBook: pctOfBookSchema,
    convictionTier: {
      type: 'string',
      enum: [...Enums.convictionTier],
      description: 'Tier derived from pctOfBook.',
    },
  },
} as const;

// ---------- Envelope assembly ----------

const summaryStatsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['count', 'totalConvictionWeight', 'topByPctOfBookFilerCIK'],
  properties: {
    count: {
      type: 'integer',
      minimum: 0,
      description: 'Total rows in the answer (post-truncation).',
    },
    totalConvictionWeight: {
      type: 'number',
      minimum: 0,
      description:
        'Sum of pctOfBook across all rows in the answer. Decimal (NOT a percentage). Example: 0.0832 ≈ 8.32pp combined book weight.',
      examples: [0.0832],
    },
    topByPctOfBookFilerCIK: {
      type: ['string', 'null'],
      pattern: Patterns.cik,
      description:
        'CIK of the filer with the highest pctOfBook in the answer; null when rows are empty.',
    },
  },
} as const;

const clusterSignalSchema = {
  type: ['object', 'null'],
  description:
    'Cluster signal. ALWAYS PRESENT in every Query envelope (calibration 3) — null when no cluster (or cluster not applicable). Stable shape across tools; never omitted.',
  additionalProperties: false,
  required: ['detected', 'tier', 'memberCount', 'memberCIKs', 'strength'],
  properties: {
    detected: {
      type: 'boolean',
      description:
        'True iff at least 3 superinvestors had a "new" or "add" event on the ticker in this quarter.',
    },
    tier: {
      type: ['string', 'null'],
      enum: [...Enums.clusterTier, null],
      description:
        "'weak' (3-4 members) | 'notable' (5-7) | 'strong' (>=8). Null when detected=false.",
    },
    memberCount: {
      type: 'integer',
      minimum: 0,
      description: 'Count of superinvestors in the cluster.',
    },
    memberCIKs: {
      type: 'array',
      description: 'Filer CIKs of cluster members.',
      items: cikSchema,
    },
    strength: {
      type: 'number',
      description:
        'Sum of pctOfBookDelta across cluster members (priorPctOfBook=0 for new initiations). Decimal; example 0.0432 ≈ 4.32pp combined.',
      examples: [0.0432],
    },
  },
} as const;

const factSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['claim', 'filerCIK', 'accessionNumber', 'sourceURL', 'filedAt'],
  properties: {
    claim: {
      type: 'string',
      description: 'Short human-readable statement of the fact, paraphrasable by the synthesiser.',
      examples: ['Berkshire initiated POOL with 0.18% of book'],
    },
    filerCIK: cikSchema,
    accessionNumber: accessionSchema,
    sourceURL: sourceURLSchema,
    filedAt: isoDateSchema,
  },
} as const;

const evidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['facts', 'sourceRefs', 'assumptions', 'unknowns'],
  properties: {
    facts: {
      type: 'array',
      description:
        "Per-row claim provenance. Every cited fact traces back to a real EDGAR filing. The runtime renders these in 'evidence_only' mode without prose.",
      items: factSchema,
    },
    sourceRefs: {
      type: 'array',
      description: 'Deduped list of source URLs (one per accession).',
      items: sourceURLSchema,
    },
    assumptions: {
      type: 'array',
      description: 'Modeling assumptions surfaced to the consumer.',
      items: {
        type: 'string',
        description: 'Free-form assumption string.',
      },
    },
    unknowns: {
      type: 'array',
      description: 'Things we explicitly did NOT determine (so consumers do not infer them).',
      items: {
        type: 'string',
        description: 'Free-form unknown string.',
      },
    },
  },
} as const;

const freshnessSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['asOf', 'currentQuarter', 'priorQuarter', 'lastIngestionRunAt', 'notes'],
  properties: {
    asOf: {
      ...isoDateTimeSchema,
      description: 'Timestamp of the most recent successful ingestion run.',
    },
    currentQuarter: {
      type: ['string', 'null'],
      pattern: Patterns.isoQuarterEnd,
      description: 'periodOfReport for the current-quarter side of the answer.',
    },
    priorQuarter: {
      type: ['string', 'null'],
      pattern: Patterns.isoQuarterEnd,
      description: 'periodOfReport for the prior-quarter side of the answer.',
    },
    lastIngestionRunAt: isoDateTimeSchema,
    notes: {
      type: ['string', 'null'],
      description: "Free-form freshness notes, e.g. 'Q4 2025 filing season concluded 2026-02-17.'",
    },
  },
} as const;

const confidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['level', 'reasoning', 'factCount', 'gapSignals'],
  properties: {
    level: {
      type: 'string',
      enum: [...Enums.confidenceLevel],
      description: "'high' | 'moderate' | 'low' overall confidence in the answer.",
    },
    reasoning: {
      type: 'string',
      description: 'One- or two-sentence rationale for the confidence level.',
    },
    factCount: {
      type: 'integer',
      minimum: 0,
      description: 'Count of evidence.facts entries supporting the answer.',
    },
    gapSignals: {
      type: 'array',
      description:
        "Closed taxonomy of recognised gap signals (calibration 2). Lets machine consumers discriminate the source of confidence loss. Allowed values: 'fuzzy_match_below_threshold' | 'missing_prior_quarter_for_filer' | 'missing_current_quarter_for_filer' | 'cusip_unresolved' | 'amendment_pending'.",
      items: {
        type: 'string',
        enum: [...Enums.gapSignal],
        description: 'A single gap signal token from the closed taxonomy.',
      },
    },
  },
} as const;

const viewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'primaryColumn', 'weightColumn'],
  properties: {
    kind: {
      type: 'string',
      enum: [...Enums.viewKind],
      description:
        "Render hint for the Context app: 'table' | 'leaderboard' | 'timeseries' | 'summary'.",
    },
    primaryColumn: {
      type: 'string',
      description: "Suggested primary column label, e.g. 'filerName'.",
    },
    weightColumn: {
      type: 'string',
      description: "Suggested column to drive bar/heat sizing, e.g. 'pctOfBook'.",
    },
  },
} as const;

const metaSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'coverageScope',
    'seasonStatus',
    'filersIngestedCount',
    'restatementApplied',
    'valueScale',
    'truncated',
    'totalRowsAvailable',
    'limitApplied',
  ],
  properties: {
    coverageScope: {
      type: 'string',
      enum: ['long_us_equity'],
      description:
        "Constant 'long_us_equity'. Surfaces the explicit scope so consumers do not misread 'no holding' as 'no exposure'.",
    },
    seasonStatus: {
      type: 'string',
      enum: [...Enums.seasonStatus],
      description: "'complete' | 'in_progress' | 'between_seasons'.",
    },
    filersIngestedCount: {
      type: 'integer',
      minimum: 0,
      description: 'Total distinct filers ingested for the current quarter.',
    },
    restatementApplied: {
      type: 'boolean',
      description:
        'True iff a 13F-HR/A amendment changed any holding referenced by this answer (calibration: amendment handling).',
    },
    valueScale: {
      type: 'string',
      enum: [...Enums.valueScale],
      description:
        "Source-regime scale of the underlying 13F values. 'USD' (post-2023-Q3) or 'USD_THOUSANDS' (pre-2023-Q3). All numeric fields in the response are normalised to dollars regardless.",
    },
    truncated: {
      type: 'boolean',
      description:
        'True iff rows were truncated by the input limit. Honest signal of incompleteness, NOT an error (calibration 5).',
    },
    totalRowsAvailable: {
      type: 'integer',
      minimum: 0,
      description: 'Row count BEFORE truncation. Equals count when truncated=false.',
    },
    limitApplied: {
      type: 'integer',
      minimum: 1,
      description: 'The limit that was applied to produce these rows.',
    },
  },
} as const;

/**
 * Build a complete Query-tool envelope outputSchema with the given `rows` schema.
 * Root is always { type: "object" }.
 */
export function envelopeSchema<T extends Record<string, unknown>>(rowsSchema: T) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'summary',
      'rows',
      'summaryStats',
      'clusterSignal',
      'evidence',
      'freshness',
      'confidence',
      'view',
      'meta',
    ],
    properties: {
      summary: {
        type: 'string',
        description:
          'One-paragraph, human-friendly summary of the answer. Synthesisers rank this first when rendering answer_with_evidence.',
      },
      rows: rowsSchema,
      summaryStats: summaryStatsSchema,
      clusterSignal: clusterSignalSchema,
      evidence: evidenceSchema,
      freshness: freshnessSchema,
      confidence: confidenceSchema,
      view: viewSchema,
      meta: metaSchema,
    },
  } as const;
}

// Convenience: an array-of-rows wrapper for tools whose `rows` is a flat list.
export function rowsArraySchema<T extends Record<string, unknown>>(
  itemSchema: T,
  description: string,
) {
  return {
    type: 'array',
    description,
    items: itemSchema,
  } as const;
}
