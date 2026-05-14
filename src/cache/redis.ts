// RedisCache: production-grade hot cache backed by ioredis.
//
// Read-through pattern: GET → on miss compute() then SETEX. Errors from
// Redis are swallowed and fall through to compute() so a momentary Redis
// outage degrades gracefully instead of taking the request path down.

import { Redis } from 'ioredis';
import type { CacheProvider } from './types.js';

export interface RedisCacheOptions {
  /** Connection URL, e.g. redis://localhost:6379 or rediss://upstash... */
  url: string;
  /** Optional prefix on every key for environment isolation. Default "helm13f:". */
  keyPrefix?: string;
  /** Optional logger for cache misses / errors. Default: silent. */
  logger?: (event: { kind: 'miss' | 'hit' | 'error'; key: string; error?: unknown }) => void;
}

export class RedisCache implements CacheProvider {
  private readonly client: Redis;
  private readonly keyPrefix: string;
  private readonly log: NonNullable<RedisCacheOptions['logger']>;

  constructor(opts: RedisCacheOptions) {
    this.client = new Redis(opts.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    this.keyPrefix = opts.keyPrefix ?? 'helm13f:';
    this.log = opts.logger ?? (() => {});
    // Connect eagerly but tolerate failure — the cache is non-load-bearing.
    this.client.connect().catch((err: unknown) => {
      this.log({ kind: 'error', key: '<connect>', error: err });
    });
  }

  async getOrCompute<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    const fullKey = this.keyPrefix + key;
    try {
      const cached = await this.client.get(fullKey);
      if (cached !== null) {
        this.log({ kind: 'hit', key: fullKey });
        return JSON.parse(cached) as T;
      }
    } catch (err: unknown) {
      this.log({ kind: 'error', key: fullKey, error: err });
      // Fall through to compute.
    }
    this.log({ kind: 'miss', key: fullKey });
    const value = await compute();
    // Do not negatively cache: a null/undefined here means the upstream
    // (DB) has nothing yet, but it may exist soon (e.g. after an
    // ingestion run). Caching it would poison subsequent reads for the
    // full TTL window even after the data lands.
    if (value !== null && value !== undefined) {
      try {
        await this.client.set(fullKey, JSON.stringify(value), 'PX', Math.max(1, Math.floor(ttlMs)));
      } catch (err: unknown) {
        this.log({ kind: 'error', key: fullKey, error: err });
      }
    }
    return value;
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(this.keyPrefix + key);
    } catch (err: unknown) {
      this.log({ kind: 'error', key, error: err });
    }
  }

  async delPrefix(prefix: string): Promise<number> {
    const pattern = `${this.keyPrefix}${prefix}*`;
    let total = 0;
    try {
      // SCAN + DEL — safe for production, avoids KEYS-blocking.
      const stream = this.client.scanStream({ match: pattern, count: 200 });
      const batches: Array<Promise<number>> = [];
      for await (const keys of stream as AsyncIterable<string[]>) {
        if (keys.length === 0) continue;
        batches.push(this.client.del(...keys));
      }
      const counts = await Promise.all(batches);
      for (const n of counts) total += n;
    } catch (err: unknown) {
      this.log({ kind: 'error', key: prefix, error: err });
    }
    return total;
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // ignore
    }
  }
}
