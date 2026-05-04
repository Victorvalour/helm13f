// OpenFigiClient tests with mocked fetch.

import { describe, it, expect } from 'vitest';
import {
  OpenFigiClient,
  OpenFigiHttpError,
  pickPrimaryUSEquity,
} from '../../../src/sources/openfigi/index.js';

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
    if (!spec) throw new Error('no response specs configured');
    i += 1;
    const headers = new Headers(spec.headers ?? {});
    return Promise.resolve(new Response(spec.body ?? '', { status: spec.status, headers }));
  };
  return { fn, calls };
}

const HIT_AAPL_US = {
  figi: 'BBG000B9XRY4',
  name: 'APPLE INC',
  ticker: 'AAPL',
  exchCode: 'US',
  compositeFIGI: 'BBG000B9XRY4',
  uniqueID: null,
  securityType: 'Common Stock',
  marketSector: 'Equity',
  shareClassFIGI: 'BBG001S5N8V8',
  uniqueIDFutOpt: null,
  securityType2: 'Common Stock',
  securityDescription: 'AAPL',
};

const HIT_AAPL_NAS = {
  ...HIT_AAPL_US,
  exchCode: 'UQ',
};

describe('OpenFigiClient — happy path', () => {
  it('maps a single CUSIP to its US ticker', async () => {
    const mock = makeMockFetch([{ status: 200, body: JSON.stringify([{ data: [HIT_AAPL_US] }]) }]);
    const c = new OpenFigiClient({
      fetchImpl: mock.fn,
      sleep: () => Promise.resolve(),
    });
    const hit = await c.mapCusip('037833100');
    expect(hit?.ticker).toBe('AAPL');
    expect(hit?.exchCode).toBe('US');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe('https://api.openfigi.com/v3/mapping');
    const body = JSON.parse(mock.calls[0]!.init.body as string) as Array<{
      idType: string;
      idValue: string;
      exchCode?: string;
    }>;
    expect(body).toEqual([{ idType: 'ID_CUSIP', idValue: '037833100', exchCode: 'US' }]);
  });

  it('omits API-key header when no apiKey set', async () => {
    const mock = makeMockFetch([{ status: 200, body: JSON.stringify([{ data: [HIT_AAPL_US] }]) }]);
    const c = new OpenFigiClient({
      fetchImpl: mock.fn,
      sleep: () => Promise.resolve(),
    });
    await c.mapCusip('037833100');
    const headers = mock.calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-OPENFIGI-APIKEY']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sets X-OPENFIGI-APIKEY when apiKey is provided', async () => {
    const mock = makeMockFetch([{ status: 200, body: JSON.stringify([{ data: [HIT_AAPL_US] }]) }]);
    const c = new OpenFigiClient({
      apiKey: 'TEST-KEY',
      fetchImpl: mock.fn,
      sleep: () => Promise.resolve(),
    });
    await c.mapCusip('037833100');
    const headers = mock.calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-OPENFIGI-APIKEY']).toBe('TEST-KEY');
  });

  it('handles unknown CUSIP via "error" entry → null result', async () => {
    const mock = makeMockFetch([
      {
        status: 200,
        body: JSON.stringify([{ error: 'No identifier found.' }]),
      },
    ]);
    const c = new OpenFigiClient({
      fetchImpl: mock.fn,
      sleep: () => Promise.resolve(),
    });
    const hit = await c.mapCusip('XXXXXXXXX');
    expect(hit).toBeNull();
  });
});

describe('OpenFigiClient — batching', () => {
  it('chunks requests to maxJobsPerRequest (10 unauth)', async () => {
    // Pre-build 12 entries; the client should issue 2 HTTP calls.
    const cusips = [
      '037833100',
      '02005N100',
      '084670108',
      '084670702',
      '023135106',
      '030419106',
      '584404105',
      '579780206',
      '037833109',
      '037833210',
      '037833311',
      '037833412',
    ];
    const firstBatch = cusips.slice(0, 10).map((c) => ({
      data: [{ ...HIT_AAPL_US, ticker: `T-${c.slice(0, 3)}` }],
    }));
    const secondBatch = cusips.slice(10).map((c) => ({
      data: [{ ...HIT_AAPL_US, ticker: `T-${c.slice(0, 3)}` }],
    }));
    const mock = makeMockFetch([
      { status: 200, body: JSON.stringify(firstBatch) },
      { status: 200, body: JSON.stringify(secondBatch) },
    ]);
    const c = new OpenFigiClient({
      fetchImpl: mock.fn,
      sleep: () => Promise.resolve(),
    });
    const out = await c.mapCusips(cusips);
    expect(out.size).toBe(12);
    expect(mock.calls).toHaveLength(2);
    // First request body has 10 jobs; second has 2.
    const b1 = JSON.parse(mock.calls[0]!.init.body as string) as unknown[];
    const b2 = JSON.parse(mock.calls[1]!.init.body as string) as unknown[];
    expect(b1).toHaveLength(10);
    expect(b2).toHaveLength(2);
  });

  it('chunks at 100 when apiKey is provided', async () => {
    const cusips = Array.from({ length: 105 }, (_, i) => String(i).padStart(9, '0'));
    const responses: MockResponseSpec[] = [
      {
        status: 200,
        body: JSON.stringify(cusips.slice(0, 100).map(() => ({ data: [HIT_AAPL_US] }))),
      },
      {
        status: 200,
        body: JSON.stringify(cusips.slice(100).map(() => ({ data: [HIT_AAPL_US] }))),
      },
    ];
    const mock = makeMockFetch(responses);
    const c = new OpenFigiClient({
      apiKey: 'TEST-KEY',
      fetchImpl: mock.fn,
      sleep: () => Promise.resolve(),
    });
    await c.mapCusips(cusips);
    expect(mock.calls).toHaveLength(2);
  });

  it('dedupes input CUSIPs before chunking', async () => {
    const mock = makeMockFetch([{ status: 200, body: JSON.stringify([{ data: [HIT_AAPL_US] }]) }]);
    const c = new OpenFigiClient({
      fetchImpl: mock.fn,
      sleep: () => Promise.resolve(),
    });
    await c.mapCusips(['037833100', '037833100', '037833100']);
    expect(mock.calls).toHaveLength(1);
    const body = JSON.parse(mock.calls[0]!.init.body as string) as unknown[];
    expect(body).toHaveLength(1);
  });

  it('returns empty map for empty input without HTTP call', async () => {
    const mock = makeMockFetch([{ status: 200, body: '[]' }]);
    const c = new OpenFigiClient({
      fetchImpl: mock.fn,
      sleep: () => Promise.resolve(),
    });
    const out = await c.mapCusips([]);
    expect(out.size).toBe(0);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('OpenFigiClient — retries', () => {
  it('honours Retry-After on 429 then succeeds', async () => {
    const mock = makeMockFetch([
      { status: 429, body: 'rl', headers: { 'retry-after': '1' } },
      { status: 200, body: JSON.stringify([{ data: [HIT_AAPL_US] }]) },
    ]);
    const sleeps: number[] = [];
    const c = new OpenFigiClient({
      fetchImpl: mock.fn,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const hit = await c.mapCusip('037833100');
    expect(hit?.ticker).toBe('AAPL');
    expect(sleeps).toEqual([1000]);
  });

  it('retries 5xx with exponential backoff', async () => {
    const mock = makeMockFetch([
      { status: 503, body: 'down' },
      { status: 502, body: 'bad gw' },
      { status: 200, body: JSON.stringify([{ data: [HIT_AAPL_US] }]) },
    ]);
    const sleeps: number[] = [];
    const c = new OpenFigiClient({
      fetchImpl: mock.fn,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      retryBaseMs: 100,
      maxRetries: 3,
    });
    const hit = await c.mapCusip('037833100');
    expect(hit?.ticker).toBe('AAPL');
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(100);
    expect(sleeps[1]!).toBeGreaterThanOrEqual(200);
  });

  it('throws after exhausting retries on 503', async () => {
    const mock = makeMockFetch(Array.from({ length: 5 }, () => ({ status: 503, body: 'down' })));
    const c = new OpenFigiClient({
      fetchImpl: mock.fn,
      sleep: () => Promise.resolve(),
      retryBaseMs: 1,
      maxRetries: 2,
    });
    await expect(c.mapCusip('037833100')).rejects.toBeInstanceOf(OpenFigiHttpError);
    expect(mock.calls).toHaveLength(3);
  });

  it('throws on 4xx without retry', async () => {
    const mock = makeMockFetch([{ status: 400, body: 'bad' }]);
    const c = new OpenFigiClient({
      fetchImpl: mock.fn,
      sleep: () => Promise.resolve(),
    });
    await expect(c.mapCusip('037833100')).rejects.toBeInstanceOf(OpenFigiHttpError);
    expect(mock.calls).toHaveLength(1);
  });
});

describe('pickPrimaryUSEquity', () => {
  it('prefers exchCode=US (composite ticker)', () => {
    expect(pickPrimaryUSEquity([HIT_AAPL_NAS, HIT_AAPL_US])).toBe(HIT_AAPL_US);
  });

  it("falls back to NYSE/NASDAQ-family exchange when 'US' missing", () => {
    expect(pickPrimaryUSEquity([HIT_AAPL_NAS])).toBe(HIT_AAPL_NAS);
  });

  it('returns null when no hit has a ticker', () => {
    const noTicker = { ...HIT_AAPL_US, ticker: null };
    expect(pickPrimaryUSEquity([noTicker])).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(pickPrimaryUSEquity([])).toBeNull();
  });
});
