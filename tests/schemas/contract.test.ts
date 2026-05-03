// Contract tests for Phase 2.
//
// Validates that:
//   1. Every tool's outputSchema has root type 'object' (Context requirement).
//   2. A synthetic example payload validates against every outputSchema.
//   3. The isSuperinvestor × superinvestorTier invariant is upheld in every fixture
//      (parser/loader will enforce this; contract test is the second line of defence).
//   4. Required envelope fields are present on every Query envelope: summary, rows,
//      summaryStats, clusterSignal (nullable but present), evidence, freshness,
//      confidence, view, meta.
//   5. meta.truncated, meta.totalRowsAvailable, meta.limitApplied are always present.
//   6. _meta.surface = 'both' on every tool.

import { describe, it, expect } from 'vitest';
// ajv 8 + ajv-formats publish CJS default exports; under NodeNext+ESM the
// default-import binding works at runtime but the TS type isn't constructable.
// Cast to a constructor / function shape explicitly.
import AjvImport from 'ajv';
import addFormatsImport from 'ajv-formats';
const Ajv = AjvImport as unknown as new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ((data: unknown) => boolean) & { errors: unknown };
};
const addFormats = addFormatsImport as unknown as (ajv: unknown) => unknown;

import {
  Q1,
  Q2,
  Q3,
  Q4,
  Q5,
  Q6,
  E1,
  E2,
  E3,
  E4,
  E5,
  ALL_TOOLS,
} from '../../src/server/schemas/index.js';

const ajv = new Ajv({
  strict: false, // Context publishes loose JSON Schemas; we don't enforce strict here.
  allErrors: true,
});
addFormats(ajv);

// ---------- Synthetic fixtures ----------
//
// Every fixture is internally consistent and respects the
// isSuperinvestor × superinvestorTier invariant.

const EVIDENCE_FACT = {
  claim: 'Berkshire initiated POOL with 0.18% of book',
  filerCIK: '0001067983',
  accessionNumber: '0001193125-26-054580',
  sourceURL:
    'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml',
  filedAt: '2026-02-17',
};

const COMMON_ENVELOPE_FIELDS = {
  evidence: {
    facts: [EVIDENCE_FACT],
    sourceRefs: [
      'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml',
    ],
    assumptions: [
      'Long US equity disclosures only; 13F-HR does not include short positions or 13D/13G holdings.',
    ],
    unknowns: [],
  },
  freshness: {
    asOf: '2026-05-03T00:00:00Z',
    currentQuarter: '2025-12-31',
    priorQuarter: '2025-09-30',
    lastIngestionRunAt: '2026-05-03T03:14:00Z',
    notes: 'Q4 2025 filing season concluded 2026-02-17.',
  },
  confidence: {
    level: 'high',
    reasoning: 'All filers in answer have parsed Q4 2025 filings.',
    factCount: 1,
    gapSignals: [],
  },
  view: {
    kind: 'table',
    primaryColumn: 'filerName',
    weightColumn: 'pctOfBook',
  },
  meta: {
    coverageScope: 'long_us_equity',
    seasonStatus: 'complete',
    filersIngestedCount: 4823,
    restatementApplied: false,
    valueScale: 'USD',
    truncated: false,
    totalRowsAvailable: 1,
    limitApplied: 500,
  },
};

const SUPERINVESTOR_ROW = {
  filerCIK: '0001067983',
  filerName: 'BERKSHIRE HATHAWAY INC',
  filerDisplayName: 'Berkshire Hathaway',
  isSuperinvestor: true,
  superinvestorTier: 'legendary',
  primaryStrategy: 'value',
};

const NON_SUPERINVESTOR_ROW = {
  filerCIK: '0001234567',
  filerName: 'EXAMPLE CAPITAL MGMT LLC',
  filerDisplayName: null,
  isSuperinvestor: false,
  superinvestorTier: null, // invariant: paired with isSuperinvestor=false
  primaryStrategy: null,
};

const Q1_NEW_INITIATION_ROW = {
  ...SUPERINVESTOR_ROW,
  ticker: 'POOL',
  issuerName: 'POOL CORP',
  cusip: '73278L105',
  sharesNew: 404057,
  valueUSD: 122334566,
  pctOfBook: 0.0018,
  convictionTier: 'starter',
  bookValueUSD: 274160086701,
  currentQuarterAccessionNumber: '0001193125-26-054580',
  sourceURL:
    'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml',
  filedAt: '2026-02-17',
};

const Q2_EXIT_ROW = {
  ...SUPERINVESTOR_ROW,
  ticker: 'PARA',
  issuerName: 'PARAMOUNT GLOBAL',
  cusip: '69379Y100',
  sharesExited: 63322491,
  priorValueUSD: 781000000,
  priorPctOfBook: 0.0042,
  priorConvictionTier: 'starter',
  priorBookValueUSD: 261000000000,
  priorQuarterAccessionNumber: '0001193125-25-282901',
  currentQuarterAccessionNumber: '0001193125-26-054580',
  sourceURL:
    'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml',
  filedAt: '2026-02-17',
};

const Q3_RESIZE_ROW = {
  ...SUPERINVESTOR_ROW,
  ticker: 'OXY',
  issuerName: 'OCCIDENTAL PETROLEUM CORP',
  cusip: '674599105',
  deltaType: 'add',
  priorShares: 1000000,
  currentShares: 1500000,
  shareDeltaPct: 0.5,
  priorPctOfBook: 0.004,
  currentPctOfBook: 0.0062,
  pctOfBookDelta: 0.0022,
  priorBookValueUSD: 261000000000,
  currentBookValueUSD: 274160086701,
  priorQuarterAccessionNumber: '0001193125-25-282901',
  currentQuarterAccessionNumber: '0001193125-26-054580',
  sourceURL:
    'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml',
  filedAt: '2026-02-17',
};

const FILER_DELTA_ROWS = {
  filerCIK: '0001649339',
  filerName: 'SCION ASSET MANAGEMENT, LLC',
  filerDisplayName: 'Scion Asset Management',
  currentQuarter: '2025-12-31',
  priorQuarter: '2025-09-30',
  currentBookValueUSD: 89000000,
  priorBookValueUSD: 76000000,
  newInitiations: [Q1_NEW_INITIATION_ROW],
  exits: [Q2_EXIT_ROW],
  addedTo: [Q3_RESIZE_ROW],
  trimmedFrom: [],
  unchanged: [],
};

const TICKER_DELTA_ROWS = {
  ticker: 'POOL',
  issuerName: 'POOL CORP',
  cusip: '73278L105',
  currentQuarter: '2025-12-31',
  priorQuarter: '2025-09-30',
  newInitiations: [Q1_NEW_INITIATION_ROW],
  exits: [],
  materialAdds: [Q3_RESIZE_ROW],
  materialTrims: [],
};

const CLUSTER_SIGNAL_DETECTED = {
  detected: true,
  tier: 'notable',
  memberCount: 5,
  memberCIKs: [
    '0001067983',
    '0001649339',
    '0001336528',
    '0001029160',
    '0001113169',
  ],
  strength: 0.0432,
};

function makeQueryEnvelope(rows: unknown, options?: { clusterSignal?: unknown }) {
  return {
    summary:
      '12 managers initiated POOL last quarter; cluster strength notable (5 superinvestors, 4.32pp combined book weight).',
    rows,
    summaryStats: {
      count: Array.isArray(rows) ? rows.length : 1,
      totalConvictionWeight: 0.0832,
      topByPctOfBookFilerCIK: '0001067983',
    },
    clusterSignal: options?.clusterSignal ?? null,
    ...COMMON_ENVELOPE_FIELDS,
  };
}

// =====================================================================
// Structural assertions on every tool definition
// =====================================================================

describe('Tool definitions — structural', () => {
  it.each(ALL_TOOLS.map((t) => [t.name, t]))(
    '%s: outputSchema root is type:object',
    (_name, tool) => {
      expect(tool.outputSchema.type).toBe('object');
    },
  );

  it.each(ALL_TOOLS.map((t) => [t.name, t]))(
    '%s: inputSchema root is type:object',
    (_name, tool) => {
      expect(tool.inputSchema.type).toBe('object');
    },
  );

  it.each(ALL_TOOLS.map((t) => [t.name, t]))(
    "%s: _meta.surface = 'both'",
    (_name, tool) => {
      expect(tool._meta.surface).toBe('both');
    },
  );

  it.each(ALL_TOOLS.map((t) => [t.name, t]))(
    '%s: _meta.queryEligible = true',
    (_name, tool) => {
      expect(tool._meta.queryEligible).toBe(true);
    },
  );

  it.each(ALL_TOOLS.map((t) => [t.name, t]))(
    "%s: _meta.latencyClass = 'instant'",
    (_name, tool) => {
      expect(tool._meta.latencyClass).toBe('instant');
    },
  );

  it.each(ALL_TOOLS.map((t) => [t.name, t]))(
    '%s: _meta.pricing.executeUsd is a string',
    (_name, tool) => {
      expect(typeof tool._meta.pricing.executeUsd).toBe('string');
    },
  );

  it('There are exactly 11 tools (6 Query + 5 Execute)', () => {
    expect(ALL_TOOLS.length).toBe(11);
  });
});

// =====================================================================
// Synthetic-payload validation per tool
// =====================================================================

describe('Q1 query_new_initiations_in_ticker — outputSchema validates synthetic payload', () => {
  const validate = ajv.compile(Q1.outputSchema);
  it('valid envelope passes', () => {
    const ok = validate(makeQueryEnvelope([Q1_NEW_INITIATION_ROW]));
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

describe('Q2 query_exits_from_ticker — outputSchema validates synthetic payload', () => {
  const validate = ajv.compile(Q2.outputSchema);
  it('valid envelope passes', () => {
    const ok = validate(makeQueryEnvelope([Q2_EXIT_ROW]));
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

describe('Q3 query_material_resizes_in_ticker — outputSchema validates synthetic payload', () => {
  const validate = ajv.compile(Q3.outputSchema);
  it('valid envelope passes', () => {
    const ok = validate(makeQueryEnvelope([Q3_RESIZE_ROW]));
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

describe('Q4 query_filer_quarter_delta — outputSchema validates synthetic payload', () => {
  const validate = ajv.compile(Q4.outputSchema);
  it('valid envelope passes', () => {
    const ok = validate(makeQueryEnvelope(FILER_DELTA_ROWS));
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

describe('Q5 query_superinvestor_cluster_on_ticker — outputSchema validates synthetic payload', () => {
  const validate = ajv.compile(Q5.outputSchema);
  it('valid envelope with detected cluster passes', () => {
    const ok = validate(
      makeQueryEnvelope([Q1_NEW_INITIATION_ROW], {
        clusterSignal: CLUSTER_SIGNAL_DETECTED,
      }),
    );
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

describe('Q6 query_full_ticker_delta_picture — outputSchema validates synthetic payload', () => {
  const validate = ajv.compile(Q6.outputSchema);
  it('valid envelope passes', () => {
    const ok = validate(makeQueryEnvelope(TICKER_DELTA_ROWS));
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

describe('E1 get_filer_delta — outputSchema validates synthetic payload', () => {
  const validate = ajv.compile(E1.outputSchema);
  it('valid envelope passes', () => {
    const ok = validate(makeQueryEnvelope(FILER_DELTA_ROWS));
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

describe('E2 get_ticker_delta — outputSchema validates synthetic payload', () => {
  const validate = ajv.compile(E2.outputSchema);
  it('valid envelope passes', () => {
    const ok = validate(makeQueryEnvelope(TICKER_DELTA_ROWS));
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

describe('E3 list_superinvestors — outputSchema validates synthetic payload', () => {
  const validate = ajv.compile(E3.outputSchema);
  it('valid response passes', () => {
    const ok = validate({
      rows: [
        {
          filerCIK: '0001067983',
          displayName: 'Berkshire Hathaway',
          edgarName: 'BERKSHIRE HATHAWAY INC',
          aliases: ['Buffett', 'Warren Buffett', 'Berkshire'],
          superinvestorTier: 'legendary',
          primaryStrategy: 'value',
          lastFilingPeriodOfReport: '2025-12-31',
          lastFilingAccessionNumber: '0001193125-26-054580',
        },
        {
          filerCIK: '0001649339',
          displayName: 'Scion Asset Management',
          edgarName: 'SCION ASSET MANAGEMENT, LLC',
          aliases: ['Burry', 'Michael Burry', 'Scion'],
          superinvestorTier: 'well-known',
          primaryStrategy: 'value',
          lastFilingPeriodOfReport: '2025-12-31',
          lastFilingAccessionNumber: '0001649339-26-000003',
        },
      ],
      meta: {
        asOf: '2026-05-03T00:00:00Z',
        truncated: false,
        totalRowsAvailable: 2,
        limitApplied: null,
        notes: null,
      },
    });
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

describe('E4 list_quarters_available — outputSchema validates synthetic payload', () => {
  const validate = ajv.compile(E4.outputSchema);
  it('valid response passes', () => {
    const ok = validate({
      rows: [
        {
          periodOfReport: '2025-12-31',
          filersIngestedCount: 4823,
          isCurrentSeason: false,
          seasonStatus: 'complete',
          earliestFiledAt: '2026-01-15',
          latestFiledAt: '2026-02-17',
        },
      ],
      meta: {
        asOf: '2026-05-03T00:00:00Z',
        truncated: false,
        totalRowsAvailable: 1,
        limitApplied: null,
        notes: null,
      },
    });
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

describe('E5 get_filing — outputSchema validates synthetic payload', () => {
  const validate = ajv.compile(E5.outputSchema);
  it('valid response passes', () => {
    const ok = validate({
      accessionNumber: '0001193125-26-054580',
      filerCIK: '0001067983',
      filerName: 'BERKSHIRE HATHAWAY INC',
      form: '13F-HR',
      isAmendment: false,
      supersededByAccession: null,
      periodOfReport: '2025-12-31',
      filedAt: '2026-02-17',
      bookValueUSD: 274160086701,
      valueScale: 'USD',
      tableEntryTotal: 110,
      primaryDocURL:
        'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/primary_doc.xml',
      infoTableURL:
        'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml',
      holdings: [
        {
          ticker: null, // CUSIP-not-yet-resolved is allowed
          issuerName: 'ALLY FINL INC',
          cusip: '02005N100',
          titleOfClass: 'COM',
          shares: 19751750,
          valueUSD: 894556758,
          sshPrnamtType: 'SH',
          putCall: null,
          pctOfBook: 0.0033,
          convictionTier: 'scout',
        },
      ],
      meta: {
        asOf: '2026-05-03T00:00:00Z',
        truncated: false,
        totalRowsAvailable: 1,
        limitApplied: null,
        notes: null,
      },
    });
    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});

// =====================================================================
// Calibration assertions
// =====================================================================

describe('Calibration 1 — isSuperinvestor × superinvestorTier invariant', () => {
  it("isSuperinvestor=true ↔ superinvestorTier non-null fixture is consistent", () => {
    expect(SUPERINVESTOR_ROW.isSuperinvestor).toBe(true);
    expect(SUPERINVESTOR_ROW.superinvestorTier).not.toBeNull();
  });

  it('isSuperinvestor=false ↔ superinvestorTier=null fixture is consistent', () => {
    expect(NON_SUPERINVESTOR_ROW.isSuperinvestor).toBe(false);
    expect(NON_SUPERINVESTOR_ROW.superinvestorTier).toBeNull();
  });

  it('Q1 row schema accepts a non-superinvestor row with null tier', () => {
    const validate = ajv.compile(Q1.outputSchema);
    const env = makeQueryEnvelope([
      {
        ...Q1_NEW_INITIATION_ROW,
        ...NON_SUPERINVESTOR_ROW,
      },
    ]);
    expect(validate(env)).toBe(true);
  });
});

describe('Calibration 2 — gapSignals closed enum', () => {
  const validate = ajv.compile(Q1.outputSchema);

  it('accepts every recognised gap signal', () => {
    const env = makeQueryEnvelope([Q1_NEW_INITIATION_ROW]) as Record<string, unknown>;
    env.confidence = {
      ...(env.confidence as Record<string, unknown>),
      gapSignals: [
        'fuzzy_match_below_threshold',
        'missing_prior_quarter_for_filer',
        'missing_current_quarter_for_filer',
        'cusip_unresolved',
        'amendment_pending',
      ] as string[],
    };
    expect(validate(env)).toBe(true);
  });

  it('rejects an unknown gap signal token', () => {
    const env = makeQueryEnvelope([Q1_NEW_INITIATION_ROW]) as Record<string, unknown>;
    env.confidence = {
      ...(env.confidence as Record<string, unknown>),
      gapSignals: ['some_made_up_signal'] as string[],
    };
    expect(validate(env)).toBe(false);
  });
});

describe('Calibration 3 — clusterSignal nullable but always present', () => {
  const validate = ajv.compile(Q1.outputSchema);

  it('clusterSignal: null is accepted on Q1 (does not apply to Q1)', () => {
    const env = makeQueryEnvelope([Q1_NEW_INITIATION_ROW]);
    expect(env.clusterSignal).toBeNull();
    expect(validate(env)).toBe(true);
  });

  it('omitting clusterSignal entirely is rejected', () => {
    const env = makeQueryEnvelope([Q1_NEW_INITIATION_ROW]) as Record<string, unknown>;
    delete env.clusterSignal;
    expect(validate(env)).toBe(false);
  });
});

describe('Calibration 5 — pagination meta always present', () => {
  const validate = ajv.compile(Q1.outputSchema);

  it('truncated=true with totalRowsAvailable > limitApplied is valid', () => {
    const env = makeQueryEnvelope([Q1_NEW_INITIATION_ROW]);
    env.meta = {
      ...env.meta,
      truncated: true,
      totalRowsAvailable: 1234,
      limitApplied: 500,
    };
    expect(validate(env)).toBe(true);
  });

  it('omitting meta.truncated is rejected', () => {
    const env = makeQueryEnvelope([Q1_NEW_INITIATION_ROW]) as Record<string, unknown>;
    const meta = { ...(env.meta as Record<string, unknown>) };
    delete meta.truncated;
    env.meta = meta;
    expect(validate(env)).toBe(false);
  });

  it('omitting meta.totalRowsAvailable is rejected', () => {
    const env = makeQueryEnvelope([Q1_NEW_INITIATION_ROW]) as Record<string, unknown>;
    const meta = { ...(env.meta as Record<string, unknown>) };
    delete meta.totalRowsAvailable;
    env.meta = meta;
    expect(validate(env)).toBe(false);
  });
});
