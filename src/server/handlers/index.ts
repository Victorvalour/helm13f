// MCP tool handlers — convert the QueryService outputs into MCP responses.
//
// Every handler returns the standard MCP CallToolResult shape:
//   { content: [{ type: 'text', text: <json> }], structuredContent: <data>, isError? }
//
// `structuredContent` matches the published outputSchema (Phase 2) verbatim.
// `content[0].text` is the same payload JSON-serialised — Context's runtime
// uses structuredContent for parsing and content for fallback rendering.

import type { QueryService, ResolverCandidatePublic } from '../service/queryService.js';

export interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function err(errorCode: string, message: string, extra?: Record<string, unknown>): CallToolResult {
  const body = { errorCode, message, ...(extra ?? {}) };
  // Note: no structuredContent on errors. When present, MCP validates it
  // against the success outputSchema — an error envelope would always
  // fail that check. content[0].text + isError carry the error.
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    isError: true,
  };
}

// ---------- Validators ----------

const TICKER_RE = /^[A-Z0-9.-]{1,16}$/;
const CIK_RE = /^[0-9]{10}$/;
const ACC_RE = /^[0-9]{10}-[0-9]{2}-[0-9]{6}$/;
const QUARTER_RE = /^[0-9]{4}-(03-31|06-30|09-30|12-31)$/;

function requireTicker(args: Record<string, unknown>): string | CallToolResult {
  const t = args['ticker'];
  if (typeof t !== 'string' || !TICKER_RE.test(t.toUpperCase())) {
    return err('invalid_input', 'input.ticker must match ^[A-Z0-9.-]{1,16}$');
  }
  return t.toUpperCase();
}

function optionalQuarter(
  args: Record<string, unknown>,
  key = 'quarter',
): string | CallToolResult | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !QUARTER_RE.test(v)) {
    return err(
      'invalid_input',
      `input.${key} must be a quarter-end ISO date YYYY-(03-31|06-30|09-30|12-31)`,
    );
  }
  return v;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | CallToolResult | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    return err('invalid_input', `input.${key} must be a finite number in [${min}, ${max}]`);
  }
  return v;
}

function optionalInt(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | CallToolResult | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    return err('invalid_input', `input.${key} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

function optionalBool(
  args: Record<string, unknown>,
  key: string,
): boolean | CallToolResult | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') {
    return err('invalid_input', `input.${key} must be a boolean`);
  }
  return v;
}

function isError(v: unknown): v is CallToolResult {
  return typeof v === 'object' && v !== null && 'isError' in v;
}

// ---------- Handlers ----------

/** All public handlers keyed by tool name. */
export function makeHandlers(
  svc: QueryService,
): Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>> {
  return {
    query_new_initiations_in_ticker: async (args) => {
      const ticker = requireTicker(args);
      if (isError(ticker)) return ticker;
      const quarter = optionalQuarter(args);
      if (isError(quarter)) return quarter;
      const minPctOfBook = optionalNumber(args, 'minPctOfBook', 0, 1);
      if (isError(minPctOfBook)) return minPctOfBook;
      const includeNonSuperinvestors = optionalBool(args, 'includeNonSuperinvestors');
      if (isError(includeNonSuperinvestors)) return includeNonSuperinvestors;
      const limit = optionalInt(args, 'limit', 1, 5000);
      if (isError(limit)) return limit;

      const env = await svc.q1NewInitiations({
        ticker,
        ...(quarter !== undefined ? { quarter } : {}),
        ...(minPctOfBook !== undefined ? { minPctOfBook } : {}),
        ...(includeNonSuperinvestors !== undefined ? { includeNonSuperinvestors } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return ok(env);
    },

    query_exits_from_ticker: async (args) => {
      const ticker = requireTicker(args);
      if (isError(ticker)) return ticker;
      const quarter = optionalQuarter(args);
      if (isError(quarter)) return quarter;
      const minPriorPctOfBook = optionalNumber(args, 'minPriorPctOfBook', 0, 1);
      if (isError(minPriorPctOfBook)) return minPriorPctOfBook;
      const includeNonSuperinvestors = optionalBool(args, 'includeNonSuperinvestors');
      if (isError(includeNonSuperinvestors)) return includeNonSuperinvestors;
      const limit = optionalInt(args, 'limit', 1, 5000);
      if (isError(limit)) return limit;

      const env = await svc.q2Exits({
        ticker,
        ...(quarter !== undefined ? { quarter } : {}),
        ...(minPriorPctOfBook !== undefined ? { minPriorPctOfBook } : {}),
        ...(includeNonSuperinvestors !== undefined ? { includeNonSuperinvestors } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return ok(env);
    },

    query_material_resizes_in_ticker: async (args) => {
      const ticker = requireTicker(args);
      if (isError(ticker)) return ticker;
      const quarter = optionalQuarter(args);
      if (isError(quarter)) return quarter;
      const minDeltaPct = optionalNumber(args, 'minDeltaPct', 0, 10);
      if (isError(minDeltaPct)) return minDeltaPct;
      const direction = args['direction'];
      if (
        direction !== undefined &&
        direction !== 'add' &&
        direction !== 'trim' &&
        direction !== 'both'
      ) {
        return err('invalid_input', "input.direction must be 'add' | 'trim' | 'both'");
      }
      const includeNonSuperinvestors = optionalBool(args, 'includeNonSuperinvestors');
      if (isError(includeNonSuperinvestors)) return includeNonSuperinvestors;
      const limit = optionalInt(args, 'limit', 1, 5000);
      if (isError(limit)) return limit;

      const env = await svc.q3MaterialResizes({
        ticker,
        ...(quarter !== undefined ? { quarter } : {}),
        ...(minDeltaPct !== undefined ? { minDeltaPct } : {}),
        ...(direction !== undefined ? { direction } : {}),
        ...(includeNonSuperinvestors !== undefined ? { includeNonSuperinvestors } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return ok(env);
    },

    query_filer_quarter_delta: async (args) => {
      const filer = args['filerNameOrCIK'];
      if (typeof filer !== 'string' || filer.trim().length === 0) {
        return err('invalid_input', 'input.filerNameOrCIK is required');
      }
      const currentQuarter = optionalQuarter(args, 'currentQuarter');
      if (isError(currentQuarter)) return currentQuarter;
      const priorQuarter = optionalQuarter(args, 'priorQuarter');
      if (isError(priorQuarter)) return priorQuarter;
      const includeUnchanged = optionalBool(args, 'includeUnchanged');
      if (isError(includeUnchanged)) return includeUnchanged;
      const limit = optionalInt(args, 'limit', 1, 5000);
      if (isError(limit)) return limit;

      const out = await svc.q4FilerDelta({
        filerNameOrCIK: filer,
        ...(currentQuarter !== undefined ? { currentQuarter } : {}),
        ...(priorQuarter !== undefined ? { priorQuarter } : {}),
        ...(includeUnchanged !== undefined ? { includeUnchanged } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (out.kind === 'error') {
        return err('ambiguous_filer', 'fuzzy match below threshold', {
          candidates: out.candidates,
        });
      }
      return ok(out.envelope);
    },

    query_superinvestor_cluster_on_ticker: async (args) => {
      const ticker = requireTicker(args);
      if (isError(ticker)) return ticker;
      const quarter = optionalQuarter(args);
      if (isError(quarter)) return quarter;
      const limit = optionalInt(args, 'limit', 1, 500);
      if (isError(limit)) return limit;

      const env = await svc.q5SuperinvestorCluster({
        ticker,
        ...(quarter !== undefined ? { quarter } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return ok(env);
    },

    query_full_ticker_delta_picture: async (args) => {
      const ticker = requireTicker(args);
      if (isError(ticker)) return ticker;
      const quarter = optionalQuarter(args);
      if (isError(quarter)) return quarter;
      const minPctOfBook = optionalNumber(args, 'minPctOfBook', 0, 1);
      if (isError(minPctOfBook)) return minPctOfBook;
      const includeNonSuperinvestors = optionalBool(args, 'includeNonSuperinvestors');
      if (isError(includeNonSuperinvestors)) return includeNonSuperinvestors;
      const limit = optionalInt(args, 'limit', 1, 5000);
      if (isError(limit)) return limit;

      const env = await svc.q6FullTickerDelta({
        ticker,
        ...(quarter !== undefined ? { quarter } : {}),
        ...(minPctOfBook !== undefined ? { minPctOfBook } : {}),
        ...(includeNonSuperinvestors !== undefined ? { includeNonSuperinvestors } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return ok(env);
    },

    get_filer_delta: async (args) => {
      const cik = args['filerCIK'];
      if (typeof cik !== 'string' || !CIK_RE.test(cik)) {
        return err('invalid_input', 'input.filerCIK must be a 10-digit padded CIK');
      }
      const currentQuarter = optionalQuarter(args, 'currentQuarter');
      if (isError(currentQuarter)) return currentQuarter;
      const priorQuarter = optionalQuarter(args, 'priorQuarter');
      if (isError(priorQuarter)) return priorQuarter;
      const includeUnchanged = optionalBool(args, 'includeUnchanged');
      if (isError(includeUnchanged)) return includeUnchanged;
      const limit = optionalInt(args, 'limit', 1, 5000);
      if (isError(limit)) return limit;

      const env = await svc.e1FilerDelta({
        filerCIK: cik,
        ...(currentQuarter !== undefined ? { currentQuarter } : {}),
        ...(priorQuarter !== undefined ? { priorQuarter } : {}),
        ...(includeUnchanged !== undefined ? { includeUnchanged } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return ok(env);
    },

    get_ticker_delta: async (args) => {
      // E2 mirrors Q6. Re-dispatch through the same Q6 handler instance.
      const allHandlers = makeHandlers(svc);
      const q6 = allHandlers.query_full_ticker_delta_picture;
      if (!q6) throw new Error('handler missing: query_full_ticker_delta_picture');
      return q6({
        ...args,
        // E2's `minPctOfBookFilter` maps to Q6's `minPctOfBook`.
        ...(args['minPctOfBookFilter'] !== undefined
          ? { minPctOfBook: args['minPctOfBookFilter'] }
          : {}),
      });
    },

    list_superinvestors: async (args) => {
      const tier = args['tier'];
      if (
        tier !== undefined &&
        tier !== 'legendary' &&
        tier !== 'well-known' &&
        tier !== 'notable'
      ) {
        return err('invalid_input', "input.tier must be 'legendary' | 'well-known' | 'notable'");
      }
      const strategy = args['strategy'];
      if (strategy !== undefined && typeof strategy !== 'string') {
        return err('invalid_input', 'input.strategy must be a string');
      }
      const out = await svc.e3ListSuperinvestors({
        ...(tier !== undefined ? { tier } : {}),
        ...(strategy !== undefined ? { strategy } : {}),
      });
      return ok(out);
    },

    list_quarters_available: async (args) => {
      const filerCIK = args['filerCIK'];
      if (filerCIK !== undefined) {
        if (typeof filerCIK !== 'string' || !CIK_RE.test(filerCIK)) {
          return err('invalid_input', 'input.filerCIK must be a 10-digit padded CIK');
        }
      }
      const out = await svc.e4ListQuartersAvailable({
        ...(filerCIK !== undefined && typeof filerCIK === 'string' ? { filerCIK } : {}),
      });
      return ok(out);
    },

    get_filing: async (args) => {
      const acc = args['accessionNumber'];
      if (typeof acc !== 'string' || !ACC_RE.test(acc)) {
        return err(
          'invalid_input',
          'input.accessionNumber must match ^[0-9]{10}-[0-9]{2}-[0-9]{6}$',
        );
      }
      const out = await svc.e5GetFiling({ accessionNumber: acc });
      if (out === null) {
        return err('no_data_for_quarter', `no filing for accessionNumber=${acc}`);
      }
      return ok(out);
    },
  };
}

export type { ResolverCandidatePublic };
