// EdgarClient tests with a mocked fetch.
//
// Verifies:
//   - User-Agent header is set on every request.
//   - URL construction for each endpoint.
//   - Rate limiter is acquired before each request.
//   - 200 returns parsed body.
//   - 404 throws EdgarNotFoundError.
//   - Other 4xx throw EdgarHttpError without retry.
//   - 429 honours Retry-After then succeeds.
//   - 5xx exponential backoff then succeeds.
//   - Retry budget exhaustion throws EdgarHttpError.
//   - Helpers: padCik, accessionNoDashes, pickInfoTableFilename.

import { describe, it, expect } from 'vitest';
import {
  EdgarClient,
  EdgarHttpError,
  EdgarNotFoundError,
  TokenBucket,
  accessionNoDashes,
  padCik,
  pickInfoTableFilename,
} from '../../../src/sources/edgar/index.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface MockResponseSpec {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

function makeMockFetch(responses: MockResponseSpec[]) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn: typeof fetch = (url, init) => {
    let u: string;
    if (typeof url === 'string') u = url;
    else if (url instanceof URL) u = url.href;
    else u = url.url;
    calls.push({ url: u, init: init ?? {} });
    const spec = responses[i] ?? responses[responses.length - 1];
    if (!spec) throw new Error('makeMockFetch: no response specs configured');
    i += 1;
    const headers = new Headers(spec.headers ?? {});
    return Promise.resolve(new Response(spec.body ?? '', { status: spec.status, headers }));
  };
  return { fn, calls };
}

function unboundedBucket(): TokenBucket {
  return new TokenBucket({ capacity: 1_000_000, refillPerSec: 1_000_000 });
}

const UA = 'Helm13F-Tests test@example.com';

describe('EdgarClient — User-Agent and URL construction', () => {
  it('sets the User-Agent header on every request', async () => {
    const mock = makeMockFetch([{ status: 200, body: '{"cik":"0001067983"}' }]);
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
    });
    await client.getSubmissions('1067983');
    expect(mock.calls).toHaveLength(1);
    const init = mock.calls[0]!.init as RequestInit & {
      headers?: Record<string, string>;
    };
    expect(init.headers).toMatchObject({ 'User-Agent': UA });
  });

  it('constructs the submissions URL with a 10-digit padded CIK', async () => {
    const mock = makeMockFetch([{ status: 200, body: '{"cik":"0001067983"}' }]);
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
    });
    await client.getSubmissions(1067983);
    expect(mock.calls[0]!.url).toBe('https://data.sec.gov/submissions/CIK0001067983.json');
  });

  it('constructs the filing index URL with no leading zeros on CIK and no dashes on accession', async () => {
    const mock = makeMockFetch([
      {
        status: 200,
        body: '{"directory":{"name":"x","parent-dir":"y","item":[]}}',
      },
    ]);
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
    });
    await client.getFilingIndex('0001067983', '0001193125-26-054580');
    expect(mock.calls[0]!.url).toBe(
      'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/index.json',
    );
  });

  it('constructs the filing-file URL for the InfoTable XML', async () => {
    const mock = makeMockFetch([{ status: 200, body: '<xml/>' }]);
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
    });
    await client.getFilingFile('1067983', '0001193125-26-054580', '50240.xml');
    expect(mock.calls[0]!.url).toBe(
      'https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml',
    );
  });

  it('constructs the company_tickers URL', async () => {
    const mock = makeMockFetch([
      { status: 200, body: '{"0":{"cik_str":1,"ticker":"X","title":"X CORP"}}' },
    ]);
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
    });
    await client.getCompanyTickers();
    expect(mock.calls[0]!.url).toBe('https://www.sec.gov/files/company_tickers.json');
  });

  it('constructs the full-text search URL with forms', async () => {
    const mock = makeMockFetch([{ status: 200, body: '{"hits":{"total":{"value":0},"hits":[]}}' }]);
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
    });
    await client.fullTextSearch('berkshire', { forms: ['13F-HR', '13F-HR/A'] });
    expect(mock.calls[0]!.url).toBe(
      'https://efts.sec.gov/LATEST/search-index?q=berkshire&forms=13F-HR%2C13F-HR%2FA',
    );
  });
});

describe('EdgarClient — required user agent', () => {
  it('throws on empty userAgent', () => {
    expect(
      () =>
        new EdgarClient({
          userAgent: '',
          rateLimiter: unboundedBucket(),
          fetchImpl: makeMockFetch([{ status: 200, body: '{}' }]).fn,
        }),
    ).toThrow(/userAgent is required/);
  });
});

describe('EdgarClient — error handling', () => {
  it('throws EdgarNotFoundError on 404 (no retry)', async () => {
    const mock = makeMockFetch([{ status: 404, body: 'not found' }]);
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
    });
    await expect(client.getSubmissions('1067983')).rejects.toBeInstanceOf(EdgarNotFoundError);
    expect(mock.calls).toHaveLength(1); // no retry on 404
  });

  it('throws EdgarHttpError on 403 (no retry)', async () => {
    const mock = makeMockFetch([{ status: 403, body: 'forbidden' }]);
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
    });
    await expect(client.getSubmissions('1067983')).rejects.toBeInstanceOf(EdgarHttpError);
    expect(mock.calls).toHaveLength(1);
  });

  it('honours Retry-After on 429 then succeeds', async () => {
    const mock = makeMockFetch([
      {
        status: 429,
        body: 'rate limit',
        headers: { 'retry-after': '1' },
      },
      { status: 200, body: '{"cik":"0001067983"}' },
    ]);
    const sleeps: number[] = [];
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const out = await client.getSubmissions('1067983');
    expect(out.cik).toBe('0001067983');
    expect(mock.calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it('caps Retry-After at maxRetryAfterMs', async () => {
    const mock = makeMockFetch([
      {
        status: 429,
        body: 'too long',
        headers: { 'retry-after': '999' },
      },
      { status: 200, body: '{}' },
    ]);
    const sleeps: number[] = [];
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      maxRetryAfterMs: 5000,
    });
    await client.getCompanyTickers();
    expect(sleeps).toEqual([5000]);
  });

  it('retries 5xx with exponential backoff and ultimately succeeds', async () => {
    const mock = makeMockFetch([
      { status: 500, body: 'oops' },
      { status: 502, body: 'bad gateway' },
      { status: 200, body: '{"cik":"0001067983"}' },
    ]);
    const sleeps: number[] = [];
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      retryBaseMs: 100,
      maxRetries: 3,
    });
    const out = await client.getSubmissions('1067983');
    expect(out.cik).toBe('0001067983');
    expect(mock.calls).toHaveLength(3);
    // First retry: ~100ms, second: ~200ms (with random jitter up to retryBaseMs).
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(100);
    expect(sleeps[0]!).toBeLessThan(200);
    expect(sleeps[1]!).toBeGreaterThanOrEqual(200);
    expect(sleeps[1]!).toBeLessThan(300);
  });

  it('throws after exhausting retries on persistent 503', async () => {
    const responses = Array.from({ length: 5 }, () => ({
      status: 503,
      body: 'unavailable',
    }));
    const mock = makeMockFetch(responses);
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
      sleep: () => Promise.resolve(),
      retryBaseMs: 1,
      maxRetries: 2,
    });
    await expect(client.getSubmissions('1067983')).rejects.toBeInstanceOf(EdgarHttpError);
    // 1 initial + 2 retries = 3 calls.
    expect(mock.calls).toHaveLength(3);
  });
});

describe('EdgarClient — rate limiter is consulted before each request', () => {
  it('acquires one token per HTTP attempt (including retries)', async () => {
    const mock = makeMockFetch([
      { status: 500, body: 'x' },
      { status: 200, body: '{}' },
    ]);
    let acquires = 0;
    const fakeBucket = {
      acquire: () => {
        acquires += 1;
        return Promise.resolve();
      },
    } as unknown as TokenBucket;
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: fakeBucket,
      fetchImpl: mock.fn,
      sleep: () => Promise.resolve(),
      retryBaseMs: 1,
      maxRetries: 2,
    });
    await client.getCompanyTickers();
    expect(acquires).toBe(2);
  });
});

describe('EdgarClient — JSON parse errors', () => {
  it('throws EdgarError with body context when JSON is malformed', async () => {
    const mock = makeMockFetch([{ status: 200, body: 'not json {{{' }]);
    const client = new EdgarClient({
      userAgent: UA,
      rateLimiter: unboundedBucket(),
      fetchImpl: mock.fn,
    });
    await expect(client.getSubmissions('1067983')).rejects.toThrow(/JSON parse failed/);
  });
});

// ------------------------------------------------------------
// Helper functions
// ------------------------------------------------------------

describe('helpers', () => {
  it('padCik pads to 10 digits', () => {
    expect(padCik('1067983')).toBe('0001067983');
    expect(padCik(1067983)).toBe('0001067983');
    expect(padCik('0001067983')).toBe('0001067983');
  });

  it('padCik strips non-digits', () => {
    expect(padCik('CIK1067983')).toBe('0001067983');
  });

  it('padCik throws on empty', () => {
    expect(() => padCik('')).toThrow();
  });

  it('accessionNoDashes converts dashed to no-dash', () => {
    expect(accessionNoDashes('0001193125-26-054580')).toBe('000119312526054580');
  });

  it('accessionNoDashes throws on bad format', () => {
    expect(() => accessionNoDashes('1234567890-26-054580a')).toThrow();
    expect(() => accessionNoDashes('00011931252605458')).toThrow();
  });

  it('pickInfoTableFilename picks the only non-primary XML', () => {
    const name = pickInfoTableFilename({
      directory: {
        name: 'x',
        'parent-dir': 'y',
        item: [
          { name: 'primary_doc.xml', type: 'xml', 'last-modified': '', size: '5556' },
          { name: '50240.xml', type: 'xml', 'last-modified': '', size: '55376' },
          { name: 'index.html', type: 'html', 'last-modified': '', size: '0' },
        ],
      },
    });
    expect(name).toBe('50240.xml');
  });

  it('pickInfoTableFilename returns null when only primary_doc.xml exists', () => {
    const name = pickInfoTableFilename({
      directory: {
        name: 'x',
        'parent-dir': 'y',
        item: [{ name: 'primary_doc.xml', type: 'xml', 'last-modified': '', size: '5556' }],
      },
    });
    expect(name).toBeNull();
  });

  it('pickInfoTableFilename ties on size when multiple non-primary XMLs exist', () => {
    const name = pickInfoTableFilename({
      directory: {
        name: 'x',
        'parent-dir': 'y',
        item: [
          { name: 'a.xml', type: 'xml', 'last-modified': '', size: '100' },
          { name: 'b.xml', type: 'xml', 'last-modified': '', size: '999' },
          { name: 'primary_doc.xml', type: 'xml', 'last-modified': '', size: '5556' },
        ],
      },
    });
    expect(name).toBe('b.xml');
  });
});
