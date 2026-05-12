// Hot-cache abstraction for QueryService. Implementations: NoopCache
// (default for tests / dev without Redis), RedisCache (production).
//
// Cache semantics:
//   - JSON-serialised payloads with TTL.
//   - `getOrCompute(key, ttlMs, compute)` is the only entry point
//     handlers use: cache hit returns the deserialised value, miss
//     calls compute() and writes the result back with TTL.
//   - Per-tool TTL: 15 min default; 1 min when the input resolves to
//     "most recent quarter" (because the resolved quarter can change
//     between calls).

export interface CacheProvider {
  /**
   * Read-through cache. Returns the cached value on hit; otherwise
   * invokes `compute()`, writes the result back with TTL, and returns it.
   * `compute()` is responsible for serialising its return value to
   * something JSON.stringify-safe; primitives + plain objects + arrays
   * + nullable shapes are fine. bigint will throw — convert at the DB
   * boundary first.
   */
  getOrCompute<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T>;
  /** Invalidate a single key. */
  del(key: string): Promise<void>;
  /** Invalidate every key under a prefix. Used by ingestion post-run. */
  delPrefix(prefix: string): Promise<number>;
  /** Optional teardown (closes underlying client connections). */
  close(): Promise<void>;
}

/** Standard TTL constants. */
export const CACHE_TTL = {
  /** When the input pins a specific historical quarter — stable answer. */
  STANDARD_MS: 15 * 60 * 1000,
  /** When the input resolves to "latest" — short TTL because that resolves
   *  forward across each ingestion run. */
  LATEST_MS: 60 * 1000,
} as const;

/** Build a stable, deterministic cache key for a tool + args. */
export function buildCacheKey(tool: string, parts: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(parts).sort()) {
    const v = parts[k];
    if (v !== undefined && v !== null) ordered[k] = v;
  }
  return `${tool}|${JSON.stringify(ordered)}`;
}
