// QueryService: the business logic that every MCP tool handler delegates to.
//
// Reads only from Postgres (and optionally a Redis cache layer that lands
// in step 10). Builds the rich Query envelope per tool. Pure
// orchestration over the repos + domain functions.

import type { Database, FilingRow, HoldingRow } from '../../db/index.js';
import { FilersRepo, FilingsRepo, HoldingsRepo, IngestionLogRepo } from '../../db/index.js';
import { classifyDelta, detectCluster, shareDeltaPct, type DeltaType } from '../../domain/index.js';
import type { FilerResolver, RosterEntry } from '../../resolution/index.js';
import {
  buildEnvelope,
  type BuiltEnvelope,
  type ClusterSignal,
  type EnvelopeEvidence,
  type EnvelopeFreshness,
  type EnvelopeMeta,
  type EnvelopeSummaryStats,
  type GapSignal,
  ASSUMPTIONS_LONG_US_EQUITY,
} from './envelope.js';

// ---------- Public row shapes (mirror the Phase 2 JSON Schemas) ----------

export interface FilerIdentityRow {
  filerCIK: string;
  filerName: string;
  filerDisplayName: string | null;
  isSuperinvestor: boolean;
  superinvestorTier: 'legendary' | 'well-known' | 'notable' | null;
  primaryStrategy: string | null;
}

export interface IssuerRow {
  ticker: string | null;
  issuerName: string;
  cusip: string;
}

export interface NewInitiationRow extends FilerIdentityRow, IssuerRow {
  sharesNew: number;
  valueUSD: number;
  pctOfBook: number;
  convictionTier: 'core' | 'meaningful' | 'starter' | 'scout';
  bookValueUSD: number;
  currentQuarterAccessionNumber: string;
  sourceURL: string;
  filedAt: string;
}

export interface ExitRow extends FilerIdentityRow, IssuerRow {
  sharesExited: number;
  priorValueUSD: number;
  priorPctOfBook: number;
  priorConvictionTier: 'core' | 'meaningful' | 'starter' | 'scout';
  priorBookValueUSD: number;
  priorQuarterAccessionNumber: string;
  currentQuarterAccessionNumber: string;
  sourceURL: string;
  filedAt: string;
}

export interface ResizeRow extends FilerIdentityRow, IssuerRow {
  deltaType: 'add' | 'trim';
  priorShares: number;
  currentShares: number;
  shareDeltaPct: number;
  priorPctOfBook: number;
  currentPctOfBook: number;
  pctOfBookDelta: number;
  priorBookValueUSD: number;
  currentBookValueUSD: number;
  priorQuarterAccessionNumber: string;
  currentQuarterAccessionNumber: string;
  sourceURL: string;
  filedAt: string;
}

export interface UnchangedRow {
  cusip: string;
  ticker: string | null;
  issuerName: string;
  currentShares: number;
  currentPctOfBook: number;
}

export interface ClusterEventRow extends FilerIdentityRow, IssuerRow {
  convictionTier: 'core' | 'meaningful' | 'starter' | 'scout';
  clusterEventType: 'new' | 'add';
  sharesAttributed: number;
  priorPctOfBook: number | null;
  currentPctOfBook: number;
  pctOfBookDelta: number;
  priorQuarterAccessionNumber: string | null;
  currentQuarterAccessionNumber: string;
  sourceURL: string;
  filedAt: string;
}

export interface FilerDeltaRows {
  filerCIK: string;
  filerName: string;
  filerDisplayName: string | null;
  currentQuarter: string;
  priorQuarter: string;
  currentBookValueUSD: number;
  priorBookValueUSD: number;
  newInitiations: NewInitiationRow[];
  exits: ExitRow[];
  addedTo: ResizeRow[];
  trimmedFrom: ResizeRow[];
  unchanged: UnchangedRow[];
}

export interface TickerDeltaRows {
  ticker: string;
  issuerName: string;
  cusip: string;
  currentQuarter: string;
  priorQuarter: string;
  newInitiations: NewInitiationRow[];
  exits: ExitRow[];
  materialAdds: ResizeRow[];
  materialTrims: ResizeRow[];
}

// ---------- QueryService dependencies ----------

export interface QueryServiceDeps {
  db: Database;
  resolver: FilerResolver;
  rosterByCik: ReadonlyMap<string, RosterEntry>;
  /** Optional override for "now" (test injection). */
  now?: () => Date;
}

// ---------- QueryService ----------

export class QueryService {
  private readonly db: Database;
  private readonly resolver: FilerResolver;
  private readonly rosterByCik: ReadonlyMap<string, RosterEntry>;
  private readonly now: () => Date;

  constructor(deps: QueryServiceDeps) {
    this.db = deps.db;
    this.resolver = deps.resolver;
    this.rosterByCik = deps.rosterByCik;
    this.now = deps.now ?? (() => new Date());
  }

  // ------------------------------------------------------------
  // Q1 — query_new_initiations_in_ticker
  // ------------------------------------------------------------
  async q1NewInitiations(input: {
    ticker: string;
    quarter?: string;
    minPctOfBook?: number;
    includeNonSuperinvestors?: boolean;
    limit?: number;
  }): Promise<BuiltEnvelope<NewInitiationRow[]>> {
    const limit = input.limit ?? 500;
    const ticker = input.ticker.toUpperCase();
    const quarters = await this.resolveQuarterPair(input.quarter);
    const { current, prior } = quarters;

    const currentHoldings = await this.fetchActiveHoldingsByTicker(ticker, current);
    const priorCIKs = await this.fetchFilerCIKsHoldingTicker(ticker, prior);

    const rows: NewInitiationRow[] = [];
    for (const h of currentHoldings) {
      if (priorCIKs.has(h.filerCIK)) continue;
      if (input.minPctOfBook !== undefined && h.pctOfBook < input.minPctOfBook) continue;
      const filer = await this.fetchFiler(h.filerCIK);
      if (!input.includeNonSuperinvestors && (!filer || !filer.isSuperinvestor)) continue;
      if (!filer) continue;
      const filing = await this.fetchActiveFiling(h.filerCIK, current);
      if (!filing) continue;
      rows.push(buildNewInitiationRow(h, filer, filing));
    }

    rows.sort((a, b) => b.pctOfBook - a.pctOfBook);
    const total = rows.length;
    const truncated = total > limit;
    const truncatedRows = truncated ? rows.slice(0, limit) : rows;

    return this.wrapTickerEnvelope(
      truncatedRows,
      total,
      limit,
      truncated,
      current,
      prior,
      ticker,
      `${total} ${total === 1 ? 'manager' : 'managers'} initiated ${ticker} in the ${current} 13F season.`,
      'filerName',
      'pctOfBook',
    );
  }

  // ------------------------------------------------------------
  // Q2 — query_exits_from_ticker
  // ------------------------------------------------------------
  async q2Exits(input: {
    ticker: string;
    quarter?: string;
    minPriorPctOfBook?: number;
    includeNonSuperinvestors?: boolean;
    limit?: number;
  }): Promise<BuiltEnvelope<ExitRow[]>> {
    const limit = input.limit ?? 500;
    const ticker = input.ticker.toUpperCase();
    const { current, prior } = await this.resolveQuarterPair(input.quarter);

    const priorHoldings = await this.fetchActiveHoldingsByTicker(ticker, prior);
    const currentCIKs = await this.fetchFilerCIKsHoldingTicker(ticker, current);

    const rows: ExitRow[] = [];
    for (const h of priorHoldings) {
      if (currentCIKs.has(h.filerCIK)) continue;
      if (input.minPriorPctOfBook !== undefined && h.pctOfBook < input.minPriorPctOfBook) continue;
      const filer = await this.fetchFiler(h.filerCIK);
      if (!input.includeNonSuperinvestors && (!filer || !filer.isSuperinvestor)) continue;
      if (!filer) continue;
      const priorFiling = await this.fetchActiveFiling(h.filerCIK, prior);
      const currentFiling = await this.fetchActiveFiling(h.filerCIK, current);
      if (!priorFiling || !currentFiling) continue;
      rows.push(buildExitRow(h, filer, priorFiling, currentFiling));
    }

    rows.sort((a, b) => b.priorPctOfBook - a.priorPctOfBook);
    const total = rows.length;
    const truncated = total > limit;
    const truncatedRows = truncated ? rows.slice(0, limit) : rows;

    return this.wrapTickerEnvelope(
      truncatedRows,
      total,
      limit,
      truncated,
      current,
      prior,
      ticker,
      `${total} ${total === 1 ? 'manager' : 'managers'} exited ${ticker} in the ${current} 13F season.`,
      'filerName',
      'priorPctOfBook',
    );
  }

  // ------------------------------------------------------------
  // Q3 — query_material_resizes_in_ticker
  // ------------------------------------------------------------
  async q3MaterialResizes(input: {
    ticker: string;
    quarter?: string;
    minDeltaPct?: number;
    direction?: 'add' | 'trim' | 'both';
    includeNonSuperinvestors?: boolean;
    limit?: number;
  }): Promise<BuiltEnvelope<ResizeRow[]>> {
    const limit = input.limit ?? 500;
    const minDelta = input.minDeltaPct ?? 0.25;
    const direction = input.direction ?? 'both';
    const ticker = input.ticker.toUpperCase();
    const { current, prior } = await this.resolveQuarterPair(input.quarter);

    const currentHoldings = await this.fetchActiveHoldingsByTicker(ticker, current);
    const priorByCik = await this.fetchActiveHoldingsByTickerKeyed(ticker, prior);

    const rows: ResizeRow[] = [];
    for (const h of currentHoldings) {
      const ph = priorByCik.get(h.filerCIK);
      if (!ph) continue; // 'new', not a resize
      const delta = classifyDelta({ priorShares: ph.shares, currentShares: h.shares }, minDelta);
      if (delta !== 'add' && delta !== 'trim') continue;
      if (direction !== 'both' && direction !== delta) continue;
      const filer = await this.fetchFiler(h.filerCIK);
      if (!input.includeNonSuperinvestors && (!filer || !filer.isSuperinvestor)) continue;
      if (!filer) continue;
      const priorFiling = await this.fetchActiveFiling(h.filerCIK, prior);
      const currentFiling = await this.fetchActiveFiling(h.filerCIK, current);
      if (!priorFiling || !currentFiling) continue;
      rows.push(buildResizeRow(h, ph, delta, filer, priorFiling, currentFiling));
    }

    rows.sort((a, b) => Math.abs(b.pctOfBookDelta) - Math.abs(a.pctOfBookDelta));
    const total = rows.length;
    const truncated = total > limit;
    const truncatedRows = truncated ? rows.slice(0, limit) : rows;

    return this.wrapTickerEnvelope(
      truncatedRows,
      total,
      limit,
      truncated,
      current,
      prior,
      ticker,
      `${total} material ${total === 1 ? 'resize' : 'resizes'} (≥${(minDelta * 100).toFixed(0)}%) in ${ticker} for ${current}.`,
      'filerName',
      'pctOfBookDelta',
    );
  }

  // ------------------------------------------------------------
  // Q4 / E1 — filer dual-quarter delta
  // ------------------------------------------------------------
  async q4FilerDelta(input: {
    filerNameOrCIK: string;
    currentQuarter?: string;
    priorQuarter?: string;
    includeUnchanged?: boolean;
    limit?: number;
  }): Promise<
    | { kind: 'envelope'; envelope: BuiltEnvelope<FilerDeltaRows> }
    | {
        kind: 'error';
        errorCode: 'ambiguous_filer';
        candidates: ResolverCandidatePublic[];
      }
  > {
    const resolved = this.resolver.resolve(input.filerNameOrCIK);
    if (resolved.kind === 'ambiguous') {
      return {
        kind: 'error',
        errorCode: 'ambiguous_filer',
        candidates: resolved.candidates.map((c) => ({
          filerCIK: c.filerCIK,
          displayName: c.displayName,
          confidence: c.confidence,
        })),
      };
    }
    const filerCIK = resolved.kind === 'cik' ? resolved.filerCIK : resolved.filerCIK;
    return {
      kind: 'envelope',
      envelope: await this.computeFilerDelta(filerCIK, {
        currentQuarter: input.currentQuarter,
        priorQuarter: input.priorQuarter,
        includeUnchanged: input.includeUnchanged ?? false,
        limit: input.limit ?? 1000,
      }),
    };
  }

  /** E1: same as Q4 but only accepts a CIK (no fuzzy resolution). */
  async e1FilerDelta(input: {
    filerCIK: string;
    currentQuarter?: string;
    priorQuarter?: string;
    includeUnchanged?: boolean;
    limit?: number;
  }): Promise<BuiltEnvelope<FilerDeltaRows>> {
    return this.computeFilerDelta(input.filerCIK, {
      currentQuarter: input.currentQuarter,
      priorQuarter: input.priorQuarter,
      includeUnchanged: input.includeUnchanged ?? false,
      limit: input.limit ?? 1000,
    });
  }

  private async computeFilerDelta(
    filerCIK: string,
    opts: {
      currentQuarter: string | undefined;
      priorQuarter: string | undefined;
      includeUnchanged: boolean;
      limit: number;
    },
  ): Promise<BuiltEnvelope<FilerDeltaRows>> {
    const filer = await this.fetchFiler(filerCIK);
    const filerName = filer?.filerName ?? `(filer ${filerCIK})`;
    const filerDisplayName = filer?.displayName ?? null;

    const current = opts.currentQuarter ?? (await this.latestQuarter());
    const prior = opts.priorQuarter ?? previousQuarterEnd(current);

    const currentFiling = await this.fetchActiveFiling(filerCIK, current);
    const priorFiling = await this.fetchActiveFiling(filerCIK, prior);

    const gapSignals: GapSignal[] = [];
    if (!currentFiling) gapSignals.push('missing_current_quarter_for_filer');
    if (!priorFiling) gapSignals.push('missing_prior_quarter_for_filer');

    const currentHoldings = currentFiling
      ? await new HoldingsRepo(this.db).listForFiling(currentFiling.accessionNumber)
      : [];
    const priorHoldings = priorFiling
      ? await new HoldingsRepo(this.db).listForFiling(priorFiling.accessionNumber)
      : [];

    const newInitiations: NewInitiationRow[] = [];
    const exits: ExitRow[] = [];
    const addedTo: ResizeRow[] = [];
    const trimmedFrom: ResizeRow[] = [];
    const unchanged: UnchangedRow[] = [];

    const priorByKey = new Map<string, HoldingRow>();
    for (const h of priorHoldings) {
      priorByKey.set(`${h.cusip}|${h.putCall ?? ''}`, h);
    }
    const currentByKey = new Map<string, HoldingRow>();
    for (const h of currentHoldings) {
      currentByKey.set(`${h.cusip}|${h.putCall ?? ''}`, h);
    }

    for (const h of currentHoldings) {
      const k = `${h.cusip}|${h.putCall ?? ''}`;
      const ph = priorByKey.get(k);
      const delta = classifyDelta({
        priorShares: ph?.shares ?? null,
        currentShares: h.shares,
      });
      if (delta === 'new' && currentFiling && filer) {
        newInitiations.push(buildNewInitiationRow(h, filer, currentFiling));
      } else if (delta === 'add' && ph && currentFiling && priorFiling && filer) {
        addedTo.push(buildResizeRow(h, ph, 'add', filer, priorFiling, currentFiling));
      } else if (delta === 'trim' && ph && currentFiling && priorFiling && filer) {
        trimmedFrom.push(buildResizeRow(h, ph, 'trim', filer, priorFiling, currentFiling));
      } else if (delta === 'unchanged' && opts.includeUnchanged) {
        unchanged.push({
          cusip: h.cusip,
          ticker: h.ticker,
          issuerName: h.issuerName,
          currentShares: bigToNumberSafe(h.shares),
          currentPctOfBook: h.pctOfBook,
        });
      }
    }
    for (const h of priorHoldings) {
      const k = `${h.cusip}|${h.putCall ?? ''}`;
      if (!currentByKey.has(k)) {
        if (currentFiling && priorFiling && filer) {
          exits.push(buildExitRow(h, filer, priorFiling, currentFiling));
        }
      }
    }

    // Sort + truncate per sub-array.
    const limit = opts.limit;
    newInitiations.sort((a, b) => b.pctOfBook - a.pctOfBook);
    exits.sort((a, b) => b.priorPctOfBook - a.priorPctOfBook);
    addedTo.sort((a, b) => b.currentPctOfBook - a.currentPctOfBook);
    trimmedFrom.sort((a, b) => b.priorPctOfBook - a.priorPctOfBook);
    let truncated = false;
    let totalAvailable = 0;
    for (const arr of [newInitiations, exits, addedTo, trimmedFrom, unchanged]) {
      totalAvailable += arr.length;
      if (arr.length > limit) {
        truncated = true;
        arr.length = limit;
      }
    }

    const rows: FilerDeltaRows = {
      filerCIK,
      filerName,
      filerDisplayName,
      currentQuarter: current,
      priorQuarter: prior,
      currentBookValueUSD: currentFiling ? bigToNumberSafe(currentFiling.bookValueUSD) : 0,
      priorBookValueUSD: priorFiling ? bigToNumberSafe(priorFiling.bookValueUSD) : 0,
      newInitiations,
      exits,
      addedTo,
      trimmedFrom,
      unchanged,
    };

    const summary = `${filerDisplayName ?? filerName} ${current} delta: ${newInitiations.length} new, ${exits.length} exits, ${addedTo.length} adds, ${trimmedFrom.length} trims.`;
    const summaryStats: EnvelopeSummaryStats = {
      count: totalAvailable,
      totalConvictionWeight: sumConvictionWeight(newInitiations, exits, addedTo),
      topByPctOfBookFilerCIK: filerCIK,
    };

    return buildEnvelope({
      summary,
      rows,
      summaryStats,
      clusterSignal: null,
      evidence: this.buildEvidence([...newInitiations, ...addedTo, ...trimmedFrom]),
      freshness: await this.buildFreshness(current, prior),
      confidence: this.buildConfidence(totalAvailable, gapSignals),
      view: { kind: 'table', primaryColumn: 'cusip', weightColumn: 'pctOfBook' },
      meta: await this.buildMeta(
        current,
        currentFiling?.valueScale ?? 'USD',
        truncated,
        totalAvailable,
        limit,
      ),
    });
  }

  // ------------------------------------------------------------
  // Q5 — query_superinvestor_cluster_on_ticker
  // ------------------------------------------------------------
  async q5SuperinvestorCluster(input: {
    ticker: string;
    quarter?: string;
    limit?: number;
  }): Promise<BuiltEnvelope<ClusterEventRow[]>> {
    const limit = input.limit ?? 500;
    const ticker = input.ticker.toUpperCase();
    const { current, prior } = await this.resolveQuarterPair(input.quarter);

    const currentHoldings = await this.fetchActiveHoldingsByTicker(ticker, current);
    const priorByKey = await this.fetchActiveHoldingsByTickerKeyed(ticker, prior);

    // Filter to superinvestors only.
    const candidates: ClusterEventRow[] = [];
    const eventInputs: Array<{
      filerCIK: string;
      eventType: 'new' | 'add';
      currentPctOfBook: number;
      priorPctOfBook: number | null;
    }> = [];
    for (const h of currentHoldings) {
      const filer = await this.fetchFiler(h.filerCIK);
      if (!filer || !filer.isSuperinvestor) continue;
      const ph = priorByKey.get(h.filerCIK);
      let eventType: 'new' | 'add' | null = null;
      if (!ph) {
        eventType = 'new';
      } else {
        const delta = classifyDelta({ priorShares: ph.shares, currentShares: h.shares }, 0.25);
        if (delta === 'add') eventType = 'add';
      }
      if (!eventType) continue;
      const priorPct = ph?.pctOfBook ?? null;
      const currentFiling = await this.fetchActiveFiling(h.filerCIK, current);
      const priorFiling = ph ? await this.fetchActiveFiling(h.filerCIK, prior) : null;
      if (!currentFiling) continue;
      eventInputs.push({
        filerCIK: h.filerCIK,
        eventType,
        currentPctOfBook: h.pctOfBook,
        priorPctOfBook: eventType === 'new' ? null : priorPct,
      });
      candidates.push({
        filerCIK: h.filerCIK,
        filerName: filer.filerName,
        filerDisplayName: filer.displayName,
        isSuperinvestor: filer.isSuperinvestor,
        superinvestorTier: filer.superinvestorTier,
        primaryStrategy: filer.primaryStrategy,
        ticker: h.ticker,
        issuerName: h.issuerName,
        cusip: h.cusip,
        convictionTier: h.convictionTier,
        clusterEventType: eventType,
        sharesAttributed:
          eventType === 'new'
            ? bigToNumberSafe(h.shares)
            : bigToNumberSafe(h.shares - (ph?.shares ?? 0n)),
        priorPctOfBook: eventType === 'new' ? null : priorPct,
        currentPctOfBook: h.pctOfBook,
        pctOfBookDelta: round6(h.pctOfBook - (priorPct ?? 0)),
        priorQuarterAccessionNumber:
          eventType === 'new' ? null : (priorFiling?.accessionNumber ?? null),
        currentQuarterAccessionNumber: currentFiling.accessionNumber,
        sourceURL: currentFiling.infoTableURL,
        filedAt: currentFiling.filingDate,
      });
    }

    const detection = detectCluster(eventInputs);
    let signal: ClusterSignal | null = null;
    if (detection.signal) {
      signal = {
        detected: true,
        tier: detection.signal.tier,
        memberCount: detection.signal.memberCount,
        memberCIKs: detection.signal.memberCIKs,
        strength: detection.signal.strength,
      };
    }

    // Truncate after the cluster is established (cluster shape is stable;
    // we just truncate the rendered rows for very large clusters).
    candidates.sort((a, b) => b.pctOfBookDelta - a.pctOfBookDelta);
    const total = candidates.length;
    const truncated = total > limit;
    const rows = truncated ? candidates.slice(0, limit) : candidates;

    const summary = signal
      ? `${signal.tier} cluster on ${ticker}: ${signal.memberCount} superinvestors, ${(signal.strength * 100).toFixed(2)}pp combined book weight.`
      : `No cluster detected on ${ticker} for ${current} (need 3+ superinvestors with new/add events).`;

    return buildEnvelope({
      summary,
      rows,
      summaryStats: {
        count: total,
        totalConvictionWeight: rows.reduce((acc, r) => acc + r.pctOfBookDelta, 0),
        topByPctOfBookFilerCIK: rows[0]?.filerCIK ?? null,
      },
      clusterSignal: signal,
      evidence: this.buildEvidence(rows),
      freshness: await this.buildFreshness(current, prior),
      confidence: this.buildConfidence(total, []),
      view: { kind: 'table', primaryColumn: 'filerName', weightColumn: 'pctOfBookDelta' },
      meta: await this.buildMeta(current, 'USD', truncated, total, limit),
    });
  }

  // ------------------------------------------------------------
  // Q6 / E2 — full ticker delta picture
  // ------------------------------------------------------------
  async q6FullTickerDelta(input: {
    ticker: string;
    quarter?: string;
    minPctOfBook?: number;
    includeNonSuperinvestors?: boolean;
    limit?: number;
  }): Promise<BuiltEnvelope<TickerDeltaRows>> {
    const limit = input.limit ?? 500;
    const ticker = input.ticker.toUpperCase();
    const { current, prior } = await this.resolveQuarterPair(input.quarter);

    const baseQ1 = {
      ticker,
      quarter: current,
      ...(input.minPctOfBook !== undefined ? { minPctOfBook: input.minPctOfBook } : {}),
      ...(input.includeNonSuperinvestors !== undefined
        ? { includeNonSuperinvestors: input.includeNonSuperinvestors }
        : {}),
      limit,
    };
    const baseQ2 = {
      ticker,
      quarter: current,
      ...(input.minPctOfBook !== undefined ? { minPriorPctOfBook: input.minPctOfBook } : {}),
      ...(input.includeNonSuperinvestors !== undefined
        ? { includeNonSuperinvestors: input.includeNonSuperinvestors }
        : {}),
      limit,
    };
    const baseQ3 = {
      ticker,
      quarter: current,
      direction: 'both' as const,
      ...(input.includeNonSuperinvestors !== undefined
        ? { includeNonSuperinvestors: input.includeNonSuperinvestors }
        : {}),
      limit,
    };
    const [news, exits, resizes] = await Promise.all([
      this.q1NewInitiations(baseQ1),
      this.q2Exits(baseQ2),
      this.q3MaterialResizes(baseQ3),
    ]);

    const materialAdds = resizes.rows.filter((r) => r.deltaType === 'add');
    const materialTrims = resizes.rows.filter((r) => r.deltaType === 'trim');

    // Resolve issuer + cusip from any current-quarter holding row.
    const repIssuer = news.rows[0] ?? materialAdds[0] ?? materialTrims[0] ?? exits.rows[0];
    const issuerName = repIssuer?.issuerName ?? '';
    const cusip = repIssuer?.cusip ?? '';

    const rows: TickerDeltaRows = {
      ticker,
      issuerName,
      cusip,
      currentQuarter: current,
      priorQuarter: prior,
      newInitiations: news.rows,
      exits: exits.rows,
      materialAdds,
      materialTrims,
    };

    const total = news.rows.length + exits.rows.length + materialAdds.length + materialTrims.length;
    const truncated = news.meta.truncated || exits.meta.truncated || resizes.meta.truncated;

    const summary = `${ticker} ${current} delta: ${news.rows.length} new, ${exits.rows.length} exits, ${materialAdds.length} adds, ${materialTrims.length} trims.`;

    return buildEnvelope({
      summary,
      rows,
      summaryStats: {
        count: total,
        totalConvictionWeight:
          news.summaryStats.totalConvictionWeight +
          exits.summaryStats.totalConvictionWeight +
          resizes.summaryStats.totalConvictionWeight,
        topByPctOfBookFilerCIK:
          news.summaryStats.topByPctOfBookFilerCIK ??
          exits.summaryStats.topByPctOfBookFilerCIK ??
          resizes.summaryStats.topByPctOfBookFilerCIK ??
          null,
      },
      clusterSignal: null,
      evidence: this.buildEvidence([
        ...news.rows,
        ...exits.rows,
        ...materialAdds,
        ...materialTrims,
      ]),
      freshness: await this.buildFreshness(current, prior),
      confidence: this.buildConfidence(total, []),
      view: { kind: 'table', primaryColumn: 'filerName', weightColumn: 'pctOfBook' },
      meta: await this.buildMeta(current, 'USD', truncated, total, limit),
    });
  }

  // ------------------------------------------------------------
  // E3 / E4 / E5 (light envelopes, not the rich Query envelope)
  // ------------------------------------------------------------

  async e3ListSuperinvestors(input: {
    tier?: 'legendary' | 'well-known' | 'notable';
    strategy?: string;
  }): Promise<{
    rows: Array<{
      filerCIK: string;
      displayName: string;
      edgarName: string;
      aliases: string[];
      superinvestorTier: 'legendary' | 'well-known' | 'notable';
      primaryStrategy: string | null;
      lastFilingPeriodOfReport: string | null;
      lastFilingAccessionNumber: string | null;
    }>;
    meta: {
      asOf: string;
      truncated: boolean;
      totalRowsAvailable: number;
      limitApplied: number | null;
      notes: string | null;
    };
  }> {
    const repo = new FilersRepo(this.db);
    const filerRows = await repo.listSuperinvestors({
      ...(input.tier ? { tier: input.tier } : {}),
      ...(input.strategy ? { strategySubstring: input.strategy } : {}),
    });
    const fRepo = new FilingsRepo(this.db);

    const rows = await Promise.all(
      filerRows.map(async (f) => {
        const last = await fRepo.listByFilerAndPeriod(f.filerCIK, '1900-01-01');
        const lastFiling = last[last.length - 1] ?? null; // empty for now; alternative path below
        const fallback = await this.lastFilingFor(f.filerCIK);
        const eff = lastFiling ?? fallback;
        return {
          filerCIK: f.filerCIK,
          displayName: f.displayName ?? f.filerName,
          edgarName: f.filerName,
          aliases: f.aliases,
          superinvestorTier: f.superinvestorTier ?? 'notable',
          primaryStrategy: f.primaryStrategy,
          lastFilingPeriodOfReport: eff?.periodOfReport ?? null,
          lastFilingAccessionNumber: eff?.accessionNumber ?? null,
        };
      }),
    );

    return {
      rows,
      meta: {
        asOf: this.now().toISOString(),
        truncated: false,
        totalRowsAvailable: rows.length,
        limitApplied: null,
        notes: null,
      },
    };
  }

  async e4ListQuartersAvailable(input: { filerCIK?: string }): Promise<{
    rows: Array<{
      periodOfReport: string;
      filersIngestedCount: number;
      isCurrentSeason: boolean;
      seasonStatus: 'complete' | 'in_progress' | 'between_seasons';
      earliestFiledAt: string;
      latestFiledAt: string;
    }>;
    meta: {
      asOf: string;
      truncated: boolean;
      totalRowsAvailable: number;
      limitApplied: number | null;
      notes: string | null;
    };
  }> {
    const where = input.filerCIK ? `WHERE filer_cik = $1` : '';
    const params = input.filerCIK ? [input.filerCIK] : [];
    const r = await this.db.query<{
      period_of_report: Date;
      filers: string;
      earliest: Date;
      latest: Date;
    }>(
      `SELECT period_of_report,
              COUNT(DISTINCT filer_cik)::text AS filers,
              MIN(filing_date) AS earliest,
              MAX(filing_date) AS latest
       FROM filings ${where}
       GROUP BY period_of_report
       ORDER BY period_of_report DESC`,
      params,
    );
    const today = this.now();
    const todayIso = today.toISOString().slice(0, 10);
    const rows = r.rows.map((row) => {
      const period = toIsoDateStr(row.period_of_report);
      const earliest = toIsoDateStr(row.earliest);
      const latest = toIsoDateStr(row.latest);
      const isCurrent = isInsideFilingWindow(period, todayIso);
      return {
        periodOfReport: period,
        filersIngestedCount: parseInt(String(row.filers), 10),
        isCurrentSeason: isCurrent,
        seasonStatus: isCurrent ? ('in_progress' as const) : ('complete' as const),
        earliestFiledAt: earliest,
        latestFiledAt: latest,
      };
    });
    return {
      rows,
      meta: {
        asOf: this.now().toISOString(),
        truncated: false,
        totalRowsAvailable: rows.length,
        limitApplied: null,
        notes: null,
      },
    };
  }

  async e5GetFiling(input: { accessionNumber: string }): Promise<{
    accessionNumber: string;
    filerCIK: string;
    filerName: string;
    form: '13F-HR' | '13F-HR/A';
    isAmendment: boolean;
    supersededByAccession: string | null;
    periodOfReport: string;
    filedAt: string;
    bookValueUSD: number;
    valueScale: 'USD' | 'USD_THOUSANDS';
    tableEntryTotal: number;
    primaryDocURL: string;
    infoTableURL: string;
    holdings: Array<{
      ticker: string | null;
      issuerName: string;
      cusip: string;
      titleOfClass: string;
      shares: number;
      valueUSD: number;
      sshPrnamtType: 'SH' | 'PRN';
      putCall: 'Put' | 'Call' | null;
      pctOfBook: number;
      convictionTier: 'core' | 'meaningful' | 'starter' | 'scout';
    }>;
    meta: {
      asOf: string;
      truncated: boolean;
      totalRowsAvailable: number;
      limitApplied: number | null;
      notes: string | null;
    };
  } | null> {
    const filingsRepo = new FilingsRepo(this.db);
    const holdingsRepo = new HoldingsRepo(this.db);
    const filersRepo = new FilersRepo(this.db);

    const filing = await filingsRepo.getByAccession(input.accessionNumber);
    if (!filing) return null;
    const filer = await filersRepo.getByCik(filing.filerCIK);
    const holdings = await holdingsRepo.listForFiling(filing.accessionNumber);

    return {
      accessionNumber: filing.accessionNumber,
      filerCIK: filing.filerCIK,
      filerName: filer?.filerName ?? '(unknown)',
      form: filing.form,
      isAmendment: filing.isAmendment,
      supersededByAccession: filing.supersededByAccession,
      periodOfReport: filing.periodOfReport,
      filedAt: filing.filingDate,
      bookValueUSD: bigToNumberSafe(filing.bookValueUSD),
      valueScale: filing.valueScale,
      tableEntryTotal: filing.tableEntryTotal,
      primaryDocURL: filing.primaryDocURL,
      infoTableURL: filing.infoTableURL,
      holdings: holdings.map((h) => ({
        ticker: h.ticker,
        issuerName: h.issuerName,
        cusip: h.cusip,
        titleOfClass: h.titleOfClass,
        shares: bigToNumberSafe(h.shares),
        valueUSD: bigToNumberSafe(h.valueUSD),
        sshPrnamtType: h.sshPrnamtType,
        putCall: h.putCall,
        pctOfBook: h.pctOfBook,
        convictionTier: h.convictionTier,
      })),
      meta: {
        asOf: this.now().toISOString(),
        truncated: false,
        totalRowsAvailable: holdings.length,
        limitApplied: null,
        notes: null,
      },
    };
  }

  // ------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------

  private async resolveQuarterPair(
    quarter: string | undefined,
  ): Promise<{ current: string; prior: string }> {
    const current = quarter ?? (await this.latestQuarter());
    const prior = previousQuarterEnd(current);
    return { current, prior };
  }

  private async latestQuarter(): Promise<string> {
    const r = await this.db.query<{ period_of_report: Date | string }>(
      `SELECT MAX(period_of_report) AS period_of_report FROM filings`,
    );
    const v = r.rows[0]?.period_of_report;
    if (!v) {
      // Fallback to the calendar-derived previous quarter.
      const today = this.now();
      const y = today.getUTCFullYear();
      const m = today.getUTCMonth();
      const qm = m >= 11 ? 11 : m >= 8 ? 8 : m >= 5 ? 5 : m >= 2 ? 2 : 11;
      const fallbackY = qm === 11 && m < 2 ? y - 1 : y;
      return `${fallbackY}-${String(qm + 1).padStart(2, '0')}-${String(lastDayOfMonthUTC(fallbackY, qm)).padStart(2, '0')}`;
    }
    return typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
  }

  private async fetchActiveHoldingsByTicker(ticker: string, period: string): Promise<HoldingRow[]> {
    return new HoldingsRepo(this.db).listActiveByTicker(ticker, period);
  }

  private async fetchActiveHoldingsByTickerKeyed(
    ticker: string,
    period: string,
  ): Promise<Map<string, HoldingRow>> {
    const rows = await this.fetchActiveHoldingsByTicker(ticker, period);
    const out = new Map<string, HoldingRow>();
    for (const r of rows) out.set(r.filerCIK, r);
    return out;
  }

  private async fetchFilerCIKsHoldingTicker(ticker: string, period: string): Promise<Set<string>> {
    const rows = await this.fetchActiveHoldingsByTicker(ticker, period);
    const out = new Set<string>();
    for (const r of rows) out.add(r.filerCIK);
    return out;
  }

  private filerCache = new Map<string, FilerLookup | null>();
  private async fetchFiler(cik: string): Promise<FilerLookup | null> {
    if (this.filerCache.has(cik)) return this.filerCache.get(cik) ?? null;
    const repo = new FilersRepo(this.db);
    const row = await repo.getByCik(cik);
    if (!row) {
      this.filerCache.set(cik, null);
      return null;
    }
    const out: FilerLookup = {
      filerCIK: row.filerCIK,
      filerName: row.filerName,
      displayName: row.displayName,
      isSuperinvestor: row.isSuperinvestor,
      superinvestorTier: row.superinvestorTier,
      primaryStrategy: row.primaryStrategy,
    };
    this.filerCache.set(cik, out);
    return out;
  }

  private filingCache = new Map<string, FilingRow | null>();
  private async fetchActiveFiling(cik: string, period: string): Promise<FilingRow | null> {
    const k = `${cik}|${period}`;
    if (this.filingCache.has(k)) return this.filingCache.get(k) ?? null;
    const repo = new FilingsRepo(this.db);
    const f = await repo.getActive(cik, period);
    this.filingCache.set(k, f);
    return f;
  }

  private async lastFilingFor(cik: string): Promise<FilingRow | null> {
    const r = await this.db.query<{
      accession_number: string;
      period_of_report: Date | string;
      filing_date: Date | string;
    }>(
      `SELECT accession_number, period_of_report, filing_date
       FROM filings WHERE filer_cik = $1
       ORDER BY period_of_report DESC, filing_date DESC LIMIT 1`,
      [cik],
    );
    const row = r.rows[0];
    if (!row) return null;
    return new FilingsRepo(this.db).getByAccession(row.accession_number);
  }

  private async buildFreshness(
    current: string | null,
    prior: string | null,
  ): Promise<EnvelopeFreshness> {
    const last = await new IngestionLogRepo(this.db).lastSuccessful();
    const lastRun = last?.completedAt ?? this.now();
    return {
      asOf: lastRun.toISOString(),
      currentQuarter: current,
      priorQuarter: prior,
      lastIngestionRunAt: lastRun.toISOString(),
      notes: null,
    };
  }

  private buildConfidence(
    factCount: number,
    gapSignals: GapSignal[],
  ): {
    level: 'high' | 'moderate' | 'low';
    reasoning: string;
    factCount: number;
    gapSignals: GapSignal[];
  } {
    let level: 'high' | 'moderate' | 'low' = 'high';
    if (gapSignals.length >= 2) level = 'low';
    else if (gapSignals.length === 1) level = 'moderate';
    return {
      level,
      reasoning:
        gapSignals.length === 0
          ? 'All input quarters fully ingested; rows trace to active 13F-HR filings.'
          : `Result missing ${gapSignals.length} input(s); see gapSignals.`,
      factCount,
      gapSignals,
    };
  }

  private async buildMeta(
    current: string,
    valueScale: 'USD' | 'USD_THOUSANDS',
    truncated: boolean,
    totalRowsAvailable: number,
    limitApplied: number,
  ): Promise<EnvelopeMeta> {
    const filersRow = await this.db.query<{ count: string }>(
      `SELECT COUNT(DISTINCT filer_cik)::text AS count
       FROM filings WHERE period_of_report = $1`,
      [current],
    );
    const filersCount = parseInt(filersRow.rows[0]?.count ?? '0', 10);
    return {
      coverageScope: 'long_us_equity',
      seasonStatus: isInsideFilingWindow(current, this.now().toISOString().slice(0, 10))
        ? 'in_progress'
        : 'complete',
      filersIngestedCount: filersCount,
      restatementApplied: false,
      valueScale,
      truncated,
      totalRowsAvailable,
      limitApplied,
    };
  }

  private buildEvidence(
    rows: ReadonlyArray<{
      filerCIK: string;
      cusip: string;
      issuerName: string;
      sourceURL?: string;
      currentQuarterAccessionNumber?: string;
      filedAt?: string;
      pctOfBook?: number;
      pctOfBookDelta?: number;
    }>,
  ): EnvelopeEvidence {
    const facts = rows
      .slice(0, 50)
      .map((r) => ({
        claim: `${r.filerCIK} on ${r.cusip} (${r.issuerName})`,
        filerCIK: r.filerCIK,
        accessionNumber: r.currentQuarterAccessionNumber ?? '',
        sourceURL: r.sourceURL ?? '',
        filedAt: r.filedAt ?? '',
      }))
      .filter((f) => f.accessionNumber && f.sourceURL && f.filedAt);
    const sourceRefs = Array.from(new Set(facts.map((f) => f.sourceURL)));
    return {
      facts,
      sourceRefs,
      assumptions: [ASSUMPTIONS_LONG_US_EQUITY],
      unknowns: [],
    };
  }

  private async wrapTickerEnvelope<R extends { length: number }>(
    rows: R,
    totalRowsAvailable: number,
    limit: number,
    truncated: boolean,
    current: string,
    prior: string,
    _ticker: string,
    summary: string,
    primaryColumn: string,
    weightColumn: string,
  ): Promise<BuiltEnvelope<R>> {
    return buildEnvelope({
      summary,
      rows,
      summaryStats: {
        count: totalRowsAvailable,
        totalConvictionWeight: sumWeightOfArray(rows as unknown as unknown[]),
        topByPctOfBookFilerCIK:
          (rows as unknown as Array<{ filerCIK: string }>)[0]?.filerCIK ?? null,
      },
      clusterSignal: null,
      evidence: this.buildEvidence(
        rows as unknown as Array<{
          filerCIK: string;
          cusip: string;
          issuerName: string;
          sourceURL?: string;
          currentQuarterAccessionNumber?: string;
          filedAt?: string;
        }>,
      ),
      freshness: await this.buildFreshness(current, prior),
      confidence: this.buildConfidence(totalRowsAvailable, []),
      view: { kind: 'table', primaryColumn, weightColumn },
      meta: await this.buildMeta(current, 'USD', truncated, totalRowsAvailable, limit),
    });
  }
}

// ---------- Helpers ----------

interface FilerLookup {
  filerCIK: string;
  filerName: string;
  displayName: string | null;
  isSuperinvestor: boolean;
  superinvestorTier: 'legendary' | 'well-known' | 'notable' | null;
  primaryStrategy: string | null;
}

export interface ResolverCandidatePublic {
  filerCIK: string;
  displayName: string;
  confidence: number;
}

function buildNewInitiationRow(
  h: HoldingRow,
  filer: FilerLookup,
  filing: FilingRow,
): NewInitiationRow {
  return {
    filerCIK: filer.filerCIK,
    filerName: filer.filerName,
    filerDisplayName: filer.displayName,
    isSuperinvestor: filer.isSuperinvestor,
    superinvestorTier: filer.superinvestorTier,
    primaryStrategy: filer.primaryStrategy,
    ticker: h.ticker,
    issuerName: h.issuerName,
    cusip: h.cusip,
    sharesNew: bigToNumberSafe(h.shares),
    valueUSD: bigToNumberSafe(h.valueUSD),
    pctOfBook: h.pctOfBook,
    convictionTier: h.convictionTier,
    bookValueUSD: bigToNumberSafe(filing.bookValueUSD),
    currentQuarterAccessionNumber: filing.accessionNumber,
    sourceURL: filing.infoTableURL,
    filedAt: filing.filingDate,
  };
}

function buildExitRow(
  priorH: HoldingRow,
  filer: FilerLookup,
  priorFiling: FilingRow,
  currentFiling: FilingRow,
): ExitRow {
  return {
    filerCIK: filer.filerCIK,
    filerName: filer.filerName,
    filerDisplayName: filer.displayName,
    isSuperinvestor: filer.isSuperinvestor,
    superinvestorTier: filer.superinvestorTier,
    primaryStrategy: filer.primaryStrategy,
    ticker: priorH.ticker,
    issuerName: priorH.issuerName,
    cusip: priorH.cusip,
    sharesExited: bigToNumberSafe(priorH.shares),
    priorValueUSD: bigToNumberSafe(priorH.valueUSD),
    priorPctOfBook: priorH.pctOfBook,
    priorConvictionTier: priorH.convictionTier,
    priorBookValueUSD: bigToNumberSafe(priorFiling.bookValueUSD),
    priorQuarterAccessionNumber: priorFiling.accessionNumber,
    currentQuarterAccessionNumber: currentFiling.accessionNumber,
    sourceURL: priorFiling.infoTableURL,
    filedAt: currentFiling.filingDate,
  };
}

function buildResizeRow(
  currentH: HoldingRow,
  priorH: HoldingRow,
  delta: DeltaType,
  filer: FilerLookup,
  priorFiling: FilingRow,
  currentFiling: FilingRow,
): ResizeRow {
  const sd = shareDeltaPct(priorH.shares, currentH.shares);
  return {
    filerCIK: filer.filerCIK,
    filerName: filer.filerName,
    filerDisplayName: filer.displayName,
    isSuperinvestor: filer.isSuperinvestor,
    superinvestorTier: filer.superinvestorTier,
    primaryStrategy: filer.primaryStrategy,
    ticker: currentH.ticker,
    issuerName: currentH.issuerName,
    cusip: currentH.cusip,
    deltaType: delta === 'add' ? 'add' : 'trim',
    priorShares: bigToNumberSafe(priorH.shares),
    currentShares: bigToNumberSafe(currentH.shares),
    shareDeltaPct: round6(sd),
    priorPctOfBook: priorH.pctOfBook,
    currentPctOfBook: currentH.pctOfBook,
    pctOfBookDelta: round6(currentH.pctOfBook - priorH.pctOfBook),
    priorBookValueUSD: bigToNumberSafe(priorFiling.bookValueUSD),
    currentBookValueUSD: bigToNumberSafe(currentFiling.bookValueUSD),
    priorQuarterAccessionNumber: priorFiling.accessionNumber,
    currentQuarterAccessionNumber: currentFiling.accessionNumber,
    sourceURL: currentFiling.infoTableURL,
    filedAt: currentFiling.filingDate,
  };
}

function bigToNumberSafe(b: bigint): number {
  return Number(b);
}

function toIsoDateStr(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function sumConvictionWeight(...arrays: ReadonlyArray<ReadonlyArray<unknown>>): number {
  let acc = 0;
  for (const arr of arrays) {
    for (const row of arr) {
      const r = row as { pctOfBook?: number; priorPctOfBook?: number };
      if (typeof r.pctOfBook === 'number') acc += r.pctOfBook;
      else if (typeof r.priorPctOfBook === 'number') acc += r.priorPctOfBook;
    }
  }
  return round6(acc);
}

function sumWeightOfArray(rows: unknown[]): number {
  let acc = 0;
  for (const r of rows) {
    const x = r as { pctOfBook?: number; pctOfBookDelta?: number; priorPctOfBook?: number };
    if (typeof x.pctOfBook === 'number') acc += x.pctOfBook;
    else if (typeof x.pctOfBookDelta === 'number') acc += x.pctOfBookDelta;
    else if (typeof x.priorPctOfBook === 'number') acc += x.priorPctOfBook;
  }
  return round6(acc);
}

function previousQuarterEnd(qe: string): string {
  // qe is YYYY-MM-DD where MM-DD is one of 03-31, 06-30, 09-30, 12-31.
  const parts = qe.split('-');
  if (parts.length !== 3) throw new Error(`previousQuarterEnd: bad input ${qe}`);
  const year = parseInt(parts[0]!, 10);
  const month = parseInt(parts[1]!, 10);
  if (month === 3) return `${year - 1}-12-31`;
  if (month === 6) return `${year}-03-31`;
  if (month === 9) return `${year}-06-30`;
  if (month === 12) return `${year}-09-30`;
  throw new Error(`previousQuarterEnd: not a quarter-end ${qe}`);
}

function lastDayOfMonthUTC(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function isInsideFilingWindow(periodOfReport: string, todayIso: string): boolean {
  // 13F filing window: quarter-end + 45 days. We treat a period as
  // "in-progress" if today is within 45 days of its end.
  const end = new Date(`${periodOfReport}T00:00:00Z`);
  const today = new Date(`${todayIso}T00:00:00Z`);
  const diffDays = (today.getTime() - end.getTime()) / 86_400_000;
  return diffDays >= 0 && diffDays <= 45;
}
