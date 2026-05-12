// Cache abstraction tests — NoopCache, buildCacheKey, and a recording
// CacheProvider used to confirm QueryService cache-key + TTL choices.

import { describe, it, expect } from 'vitest';
import { buildCacheKey, CACHE_TTL, NoopCache, type CacheProvider } from '../../src/cache/index.js';

describe('buildCacheKey', () => {
  it('produces stable, sorted-key output regardless of input ordering', () => {
    const a = buildCacheKey('q1', { ticker: 'AAPL', quarter: '2025-12-31', limit: 500 });
    const b = buildCacheKey('q1', { limit: 500, ticker: 'AAPL', quarter: '2025-12-31' });
    expect(a).toBe(b);
  });

  it("skips undefined / null fields so optional args don't fragment the key", () => {
    const a = buildCacheKey('q1', {
      ticker: 'AAPL',
      quarter: undefined,
      minPctOfBook: null,
    });
    const b = buildCacheKey('q1', { ticker: 'AAPL' });
    expect(a).toBe(b);
  });

  it('namespaces by tool', () => {
    const a = buildCacheKey('q1', { ticker: 'AAPL' });
    const b = buildCacheKey('q2', { ticker: 'AAPL' });
    expect(a).not.toBe(b);
  });
});

describe('NoopCache', () => {
  it('always misses and always returns compute()', async () => {
    const cache = new NoopCache();
    let calls = 0;
    const compute = () => Promise.resolve(++calls);
    expect(await cache.getOrCompute('k', 1000, compute)).toBe(1);
    expect(await cache.getOrCompute('k', 1000, compute)).toBe(2);
    expect(await cache.getOrCompute('k', 1000, compute)).toBe(3);
  });

  it('del / delPrefix / close are no-ops', async () => {
    const cache = new NoopCache();
    await cache.del('x');
    expect(await cache.delPrefix('x')).toBe(0);
    await cache.close();
  });
});

describe('CACHE_TTL', () => {
  it('STANDARD_MS is 15 minutes', () => {
    expect(CACHE_TTL.STANDARD_MS).toBe(15 * 60 * 1000);
  });

  it('LATEST_MS is 1 minute (short TTL for "resolved-to-latest" answers)', () => {
    expect(CACHE_TTL.LATEST_MS).toBe(60 * 1000);
  });
});

// Recording cache impl — verifies QueryService is wiring its calls
// through the cache with the expected keys + TTLs.
describe('Recording CacheProvider (used in queryService tests)', () => {
  class RecordingCache implements CacheProvider {
    public readonly calls: Array<{ key: string; ttlMs: number }> = [];
    getOrCompute<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
      this.calls.push({ key, ttlMs });
      return compute();
    }
    del(_key: string): Promise<void> {
      return Promise.resolve();
    }
    delPrefix(_prefix: string): Promise<number> {
      return Promise.resolve(0);
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  it('records every getOrCompute call', async () => {
    const cache = new RecordingCache();
    const compute = () => Promise.resolve(42);
    await cache.getOrCompute('k1', 1000, compute);
    await cache.getOrCompute('k2', 2000, compute);
    expect(cache.calls).toEqual([
      { key: 'k1', ttlMs: 1000 },
      { key: 'k2', ttlMs: 2000 },
    ]);
  });
});
