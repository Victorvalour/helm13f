// CUSIP cache + resolver tests.

import { describe, it, expect } from 'vitest';
import {
  CusipResolver,
  InMemoryCusipCache,
  LayeredCusipCache,
  normalizeTicker,
  type CusipRecord,
  type OpenFigiHit,
} from '../../../src/sources/openfigi/index.js';

class StubFigi {
  public calls: string[][] = [];
  constructor(private readonly hits: Map<string, OpenFigiHit | null>) {}

  // Mirrors OpenFigiClient.mapCusips for ducktype.
  mapCusips(cusips: readonly string[]): Promise<Map<string, OpenFigiHit | null>> {
    this.calls.push([...cusips]);
    const out = new Map<string, OpenFigiHit | null>();
    for (const c of cusips) out.set(c, this.hits.get(c) ?? null);
    return Promise.resolve(out);
  }

  mapCusip(cusip: string): Promise<OpenFigiHit | null> {
    this.calls.push([cusip]);
    return Promise.resolve(this.hits.get(cusip) ?? null);
  }
}

const FIXED_NOW = new Date('2026-05-04T00:00:00Z');

describe('normalizeTicker', () => {
  it('converts share-class "/" to "-" (EDGAR/OpenFIGI → market-data convention)', () => {
    expect(normalizeTicker('HEI/A')).toBe('HEI-A');
    expect(normalizeTicker('LEN/B')).toBe('LEN-B');
    expect(normalizeTicker('BRK/B')).toBe('BRK-B');
  });

  it('uppercases and trims', () => {
    expect(normalizeTicker(' aapl ')).toBe('AAPL');
  });

  it('returns null for null/undefined/empty', () => {
    expect(normalizeTicker(null)).toBeNull();
    expect(normalizeTicker(undefined)).toBeNull();
    expect(normalizeTicker('')).toBeNull();
    expect(normalizeTicker('   ')).toBeNull();
  });

  it('passes through already-clean tickers unchanged', () => {
    expect(normalizeTicker('AAPL')).toBe('AAPL');
    expect(normalizeTicker('BF.B')).toBe('BF.B');
    expect(normalizeTicker('BRK-B')).toBe('BRK-B');
  });
});

describe('InMemoryCusipCache — basic behaviour', () => {
  it('returns null for a missing CUSIP', async () => {
    const c = new InMemoryCusipCache();
    expect(await c.get('037833100')).toBeNull();
  });

  it('stores and retrieves a record', async () => {
    const c = new InMemoryCusipCache();
    const rec: CusipRecord = {
      cusip: '037833100',
      ticker: 'AAPL',
      issuerName: 'APPLE INC',
      source: 'openfigi',
      lastVerifiedAt: FIXED_NOW,
    };
    await c.set(rec);
    const got = await c.get('037833100');
    expect(got).toEqual(rec);
  });

  it('evicts oldest entries when capacity exceeded', async () => {
    const c = new InMemoryCusipCache(3);
    for (const cusip of ['A', 'B', 'C']) {
      await c.set({
        cusip,
        ticker: cusip,
        issuerName: null,
        source: 'openfigi',
        lastVerifiedAt: FIXED_NOW,
      });
    }
    expect(c.size()).toBe(3);
    await c.set({
      cusip: 'D',
      ticker: 'D',
      issuerName: null,
      source: 'openfigi',
      lastVerifiedAt: FIXED_NOW,
    });
    expect(c.size()).toBe(3);
    expect(await c.get('A')).toBeNull();
    expect(await c.get('D')).not.toBeNull();
  });

  it('LRU touch on read promotes recency', async () => {
    const c = new InMemoryCusipCache(2);
    await c.set({
      cusip: 'A',
      ticker: 'A',
      issuerName: null,
      source: 'openfigi',
      lastVerifiedAt: FIXED_NOW,
    });
    await c.set({
      cusip: 'B',
      ticker: 'B',
      issuerName: null,
      source: 'openfigi',
      lastVerifiedAt: FIXED_NOW,
    });
    // Touch A so B becomes the eviction candidate.
    await c.get('A');
    await c.set({
      cusip: 'C',
      ticker: 'C',
      issuerName: null,
      source: 'openfigi',
      lastVerifiedAt: FIXED_NOW,
    });
    expect(await c.get('A')).not.toBeNull();
    expect(await c.get('B')).toBeNull();
    expect(await c.get('C')).not.toBeNull();
  });

  it('getMany returns null for unknown entries and present ones for known', async () => {
    const c = new InMemoryCusipCache();
    await c.set({
      cusip: 'A',
      ticker: 'A',
      issuerName: null,
      source: 'openfigi',
      lastVerifiedAt: FIXED_NOW,
    });
    const got = await c.getMany(['A', 'B']);
    expect(got.get('A')?.ticker).toBe('A');
    expect(got.get('B')).toBeNull();
  });
});

describe('LayeredCusipCache', () => {
  it('reads from near first, falls back to far, populates near', async () => {
    const near = new InMemoryCusipCache();
    const far = new InMemoryCusipCache();
    await far.set({
      cusip: 'A',
      ticker: 'A',
      issuerName: null,
      source: 'openfigi',
      lastVerifiedAt: FIXED_NOW,
    });
    const layered = new LayeredCusipCache(near, far);
    expect(await near.get('A')).toBeNull(); // not in near yet
    expect(await layered.get('A')).not.toBeNull();
    expect(await near.get('A')).not.toBeNull(); // populated after lookup
  });

  it('writes go to both layers', async () => {
    const near = new InMemoryCusipCache();
    const far = new InMemoryCusipCache();
    const layered = new LayeredCusipCache(near, far);
    await layered.set({
      cusip: 'A',
      ticker: 'A',
      issuerName: null,
      source: 'openfigi',
      lastVerifiedAt: FIXED_NOW,
    });
    expect(await near.get('A')).not.toBeNull();
    expect(await far.get('A')).not.toBeNull();
  });
});

describe('CusipResolver — single-CUSIP path', () => {
  it('returns cache hits without calling FIGI', async () => {
    const cache = new InMemoryCusipCache();
    await cache.set({
      cusip: '037833100',
      ticker: 'AAPL',
      issuerName: 'APPLE INC',
      source: 'company_tickers',
      lastVerifiedAt: FIXED_NOW,
    });
    const figi = new StubFigi(new Map());
    const r = new CusipResolver(cache, figi as never, () => FIXED_NOW);
    const got = await r.resolve('037833100');
    expect(got?.ticker).toBe('AAPL');
    expect(figi.calls).toHaveLength(0);
  });

  it('falls back to FIGI on cache miss and writes back', async () => {
    const cache = new InMemoryCusipCache();
    const figi = new StubFigi(
      new Map([
        [
          '037833100',
          {
            figi: 'BBG',
            name: 'APPLE INC',
            ticker: 'AAPL',
            exchCode: 'US',
            compositeFIGI: null,
            uniqueID: null,
            securityType: null,
            marketSector: null,
            shareClassFIGI: null,
            uniqueIDFutOpt: null,
            securityType2: null,
            securityDescription: null,
          },
        ],
      ]),
    );
    const r = new CusipResolver(cache, figi as never, () => FIXED_NOW);
    const got = await r.resolve('037833100');
    expect(got?.ticker).toBe('AAPL');
    expect(figi.calls).toHaveLength(1);
    // Cache was populated.
    expect((await cache.get('037833100'))?.ticker).toBe('AAPL');
  });

  it('records null-ticker stub when FIGI also misses', async () => {
    const cache = new InMemoryCusipCache();
    const figi = new StubFigi(new Map());
    const r = new CusipResolver(cache, figi as never, () => FIXED_NOW);
    const got = await r.resolve('XXXXXXXXX');
    expect(got?.ticker).toBeNull();
    expect((await cache.get('XXXXXXXXX'))?.ticker).toBeNull();
  });
});

describe('CusipResolver — batch path', () => {
  it('mixes cache hits and FIGI fallbacks in one call', async () => {
    const cache = new InMemoryCusipCache();
    await cache.set({
      cusip: 'A',
      ticker: 'A-cached',
      issuerName: null,
      source: 'openfigi',
      lastVerifiedAt: FIXED_NOW,
    });
    const figi = new StubFigi(
      new Map([
        [
          'B',
          {
            figi: 'BBG-B',
            name: 'B Inc',
            ticker: 'B-figi',
            exchCode: 'US',
            compositeFIGI: null,
            uniqueID: null,
            securityType: null,
            marketSector: null,
            shareClassFIGI: null,
            uniqueIDFutOpt: null,
            securityType2: null,
            securityDescription: null,
          },
        ],
        ['C', null],
      ]),
    );
    const r = new CusipResolver(cache, figi as never, () => FIXED_NOW);
    const got = await r.resolveBatch(['A', 'B', 'C']);
    expect(got.size).toBe(3);
    // normalizeTicker uppercases on read/write
    expect(got.get('A')?.ticker).toBe('A-CACHED');
    expect(got.get('B')?.ticker).toBe('B-FIGI');
    expect(got.get('C')?.ticker).toBeNull();
    // Only one FIGI batch call, and only for the misses.
    expect(figi.calls).toHaveLength(1);
    expect(figi.calls[0]).toEqual(['B', 'C']);
  });

  it('writes FIGI hits + null stubs back to cache', async () => {
    const cache = new InMemoryCusipCache();
    const figi = new StubFigi(new Map([['B', null]]));
    const r = new CusipResolver(cache, figi as never, () => FIXED_NOW);
    await r.resolveBatch(['B']);
    const cached = await cache.get('B');
    expect(cached).not.toBeNull();
    expect(cached?.ticker).toBeNull();
    expect(cached?.source).toBe('openfigi');
  });

  it('returns null-ticker stubs without FIGI call when FIGI is null', async () => {
    const cache = new InMemoryCusipCache();
    const r = new CusipResolver(cache, null, () => FIXED_NOW);
    const got = await r.resolveBatch(['A', 'B']);
    expect(got.size).toBe(2);
    for (const v of got.values()) expect(v.ticker).toBeNull();
  });
});
