// CUSIP → ticker resolution with composable caching.
//
// Three-layer strategy in production (Phase 3.5+):
//   1. In-memory LRU cache (this file) — hottest path, populated on hit
//      from any deeper layer.
//   2. Postgres `cusip_ticker_map` table (Phase 3.5) — persists across
//      ingestion runs and survives restarts.
//   3. OpenFIGI mapping API (this module's client) — only when both
//      caches miss. Batches up to maxJobsPerRequest CUSIPs per call.
//
// This file ships layer 1 + the composition primitives. Layer 2's
// Postgres-backed implementation lands in step 5 and plugs into the
// same `CusipCache` interface.

import type { OpenFigiClient } from './client.js';

/** What we record per CUSIP. `ticker: null` is a valid record meaning
 *  "we looked and there is no US-listed ticker mapping". */
export interface CusipRecord {
  cusip: string;
  ticker: string | null;
  issuerName: string | null;
  source: 'company_tickers' | 'openfigi' | 'manual_override';
  lastVerifiedAt: Date;
}

/** Read-write cache contract. Implementations: in-memory LRU, Postgres. */
export interface CusipCache {
  get(cusip: string): Promise<CusipRecord | null>;
  getMany(cusips: readonly string[]): Promise<Map<string, CusipRecord | null>>;
  set(record: CusipRecord): Promise<void>;
  setMany(records: readonly CusipRecord[]): Promise<void>;
}

/** Fixed-size LRU. Used standalone in tests; first-line cache in prod. */
export class InMemoryCusipCache implements CusipCache {
  private readonly map = new Map<string, CusipRecord>();
  private readonly capacity: number;

  constructor(capacity = 50_000) {
    if (capacity <= 0) throw new Error('InMemoryCusipCache: capacity must be > 0');
    this.capacity = capacity;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(cusip: string): Promise<CusipRecord | null> {
    const rec = this.map.get(cusip);
    if (!rec) return null;
    // LRU touch.
    this.map.delete(cusip);
    this.map.set(cusip, rec);
    return rec;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getMany(cusips: readonly string[]): Promise<Map<string, CusipRecord | null>> {
    const out = new Map<string, CusipRecord | null>();
    for (const c of cusips) {
      const rec = this.map.get(c);
      if (rec) {
        // touch
        this.map.delete(c);
        this.map.set(c, rec);
        out.set(c, rec);
      } else {
        out.set(c, null);
      }
    }
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async set(record: CusipRecord): Promise<void> {
    if (this.map.has(record.cusip)) this.map.delete(record.cusip);
    this.map.set(record.cusip, record);
    while (this.map.size > this.capacity) {
      // Evict oldest (insertion-order Map iteration).
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  async setMany(records: readonly CusipRecord[]): Promise<void> {
    for (const r of records) await this.set(r);
  }

  /** Test/diagnostic helpers. */
  size(): number {
    return this.map.size;
  }
}

/**
 * Two-layer composer: read-through `near` first, fall back to `far`.
 * Writes propagate near-only (production wires Postgres as `near` and
 * OpenFIGI as the `farResolver` in CusipResolver below).
 */
export class LayeredCusipCache implements CusipCache {
  constructor(
    private readonly near: CusipCache,
    private readonly far: CusipCache,
  ) {}

  async get(cusip: string): Promise<CusipRecord | null> {
    const hit = await this.near.get(cusip);
    if (hit) return hit;
    const farHit = await this.far.get(cusip);
    if (farHit) {
      await this.near.set(farHit);
    }
    return farHit;
  }

  async getMany(cusips: readonly string[]): Promise<Map<string, CusipRecord | null>> {
    const nearMap = await this.near.getMany(cusips);
    const missing = cusips.filter((c) => !nearMap.get(c));
    if (missing.length === 0) return nearMap;
    const farMap = await this.far.getMany(missing);
    const populate: CusipRecord[] = [];
    for (const c of missing) {
      const fh = farMap.get(c);
      if (fh) {
        nearMap.set(c, fh);
        populate.push(fh);
      }
    }
    if (populate.length > 0) await this.near.setMany(populate);
    return nearMap;
  }

  async set(record: CusipRecord): Promise<void> {
    await this.near.set(record);
    await this.far.set(record);
  }

  async setMany(records: readonly CusipRecord[]): Promise<void> {
    await this.near.setMany(records);
    await this.far.setMany(records);
  }
}

/**
 * Top-level resolver: cache → OpenFIGI fallback. The cache chain is opaque
 * (could be in-memory, layered with Postgres, etc.). Records written back
 * to the cache always stamp `lastVerifiedAt` to `now`.
 */
/**
 * Normalize tickers from upstream sources to match our schema pattern
 * `^[A-Z0-9.\-]{1,16}$`. EDGAR/OpenFIGI return share-class tickers in
 * `HEI/A` style; our envelope schema (and most market-data vendors like
 * Yahoo Finance) use `HEI-A`. Convert / → - and uppercase.
 */
export function normalizeTicker(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const t = raw.trim().toUpperCase().replace(/\//g, '-');
  if (t.length === 0) return null;
  return t;
}

export class CusipResolver {
  constructor(
    private readonly cache: CusipCache,
    private readonly figi: OpenFigiClient | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Resolve a single CUSIP. Returns null only when both cache and FIGI miss. */
  async resolve(cusip: string): Promise<CusipRecord | null> {
    const cached = await this.cache.get(cusip);
    if (cached) return { ...cached, ticker: normalizeTicker(cached.ticker) };
    if (!this.figi) return null;
    const hit = await this.figi.mapCusip(cusip);
    const rec: CusipRecord = {
      cusip,
      ticker: normalizeTicker(hit?.ticker),
      issuerName: hit?.name ?? null,
      source: 'openfigi',
      lastVerifiedAt: this.now(),
    };
    await this.cache.set(rec);
    return rec;
  }

  /**
   * Batch-resolve. Cache misses go to OpenFIGI in a single batched call.
   * Result is keyed by the input CUSIP; every input has an entry.
   */
  async resolveBatch(cusips: readonly string[]): Promise<Map<string, CusipRecord>> {
    const out = new Map<string, CusipRecord>();
    if (cusips.length === 0) return out;
    const cached = await this.cache.getMany(cusips);
    const missing: string[] = [];
    for (const c of cusips) {
      const r = cached.get(c);
      if (r) out.set(c, { ...r, ticker: normalizeTicker(r.ticker) });
      else missing.push(c);
    }
    if (missing.length === 0 || !this.figi) {
      // Even when we can't FIGI-resolve, return null-ticker stubs so the
      // caller knows we tried.
      for (const c of missing) {
        const rec: CusipRecord = {
          cusip: c,
          ticker: null,
          issuerName: null,
          source: 'openfigi',
          lastVerifiedAt: this.now(),
        };
        out.set(c, rec);
      }
      return out;
    }
    const figiRes = await this.figi.mapCusips(missing);
    const toWrite: CusipRecord[] = [];
    const stamp = this.now();
    for (const c of missing) {
      const hit = figiRes.get(c) ?? null;
      const rec: CusipRecord = {
        cusip: c,
        ticker: normalizeTicker(hit?.ticker),
        issuerName: hit?.name ?? null,
        source: 'openfigi',
        lastVerifiedAt: stamp,
      };
      out.set(c, rec);
      toWrite.push(rec);
    }
    if (toWrite.length > 0) await this.cache.setMany(toWrite);
    return out;
  }
}
