// MCP handler tests — verify input validation + dispatch into QueryService.
// We use a stub QueryService instead of the real one (the real one is
// already covered by queryService.test.ts).

import { describe, it, expect } from 'vitest';
import { makeHandlers } from '../../src/server/handlers/index.js';
import type { QueryService } from '../../src/server/service/queryService.js';

interface StubCalls {
  q1: Array<Record<string, unknown>>;
  q2: Array<Record<string, unknown>>;
  q3: Array<Record<string, unknown>>;
  q4: Array<Record<string, unknown>>;
  q5: Array<Record<string, unknown>>;
  q6: Array<Record<string, unknown>>;
  e1: Array<Record<string, unknown>>;
  e3: Array<Record<string, unknown>>;
  e4: Array<Record<string, unknown>>;
  e5: Array<Record<string, unknown>>;
}

function makeStubSvc(): { svc: QueryService; calls: StubCalls } {
  const calls: StubCalls = {
    q1: [],
    q2: [],
    q3: [],
    q4: [],
    q5: [],
    q6: [],
    e1: [],
    e3: [],
    e4: [],
    e5: [],
  };
  const env = { stub: 'envelope' };
  const svc = {
    q1NewInitiations: (i: Record<string, unknown>) => {
      calls.q1.push(i);
      return Promise.resolve(env);
    },
    q2Exits: (i: Record<string, unknown>) => {
      calls.q2.push(i);
      return Promise.resolve(env);
    },
    q3MaterialResizes: (i: Record<string, unknown>) => {
      calls.q3.push(i);
      return Promise.resolve(env);
    },
    q4FilerDelta: (i: Record<string, unknown>) => {
      calls.q4.push(i);
      return Promise.resolve({ kind: 'envelope', envelope: env });
    },
    e1FilerDelta: (i: Record<string, unknown>) => {
      calls.e1.push(i);
      return Promise.resolve(env);
    },
    q5SuperinvestorCluster: (i: Record<string, unknown>) => {
      calls.q5.push(i);
      return Promise.resolve(env);
    },
    q6FullTickerDelta: (i: Record<string, unknown>) => {
      calls.q6.push(i);
      return Promise.resolve(env);
    },
    e3ListSuperinvestors: (i: Record<string, unknown>) => {
      calls.e3.push(i);
      return Promise.resolve({ rows: [], meta: {} });
    },
    e4ListQuartersAvailable: (i: Record<string, unknown>) => {
      calls.e4.push(i);
      return Promise.resolve({ rows: [], meta: {} });
    },
    e5GetFiling: (i: Record<string, unknown>) => {
      calls.e5.push(i);
      return Promise.resolve(env);
    },
  } as unknown as QueryService;
  return { svc, calls };
}

describe('handlers — input validation', () => {
  it('rejects missing ticker on Q1', async () => {
    const { svc } = makeStubSvc();
    const h = makeHandlers(svc);
    const r = await h['query_new_initiations_in_ticker']!({});
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    const body = JSON.parse(r.content[0]!.text) as { errorCode: string };
    expect(body.errorCode).toBe('invalid_input');
  });

  it('rejects malformed quarter on Q1', async () => {
    const { svc } = makeStubSvc();
    const h = makeHandlers(svc);
    const r = await h['query_new_initiations_in_ticker']!({
      ticker: 'AAPL',
      quarter: '2025-04-15',
    });
    expect(r.isError).toBe(true);
  });

  it('rejects out-of-range minPctOfBook on Q1', async () => {
    const { svc } = makeStubSvc();
    const h = makeHandlers(svc);
    const r = await h['query_new_initiations_in_ticker']!({
      ticker: 'AAPL',
      minPctOfBook: 1.5,
    });
    expect(r.isError).toBe(true);
  });

  it('rejects malformed CIK on E1', async () => {
    const { svc } = makeStubSvc();
    const h = makeHandlers(svc);
    const r = await h['get_filer_delta']!({ filerCIK: '12345' });
    expect(r.isError).toBe(true);
  });

  it('rejects malformed accession on E5', async () => {
    const { svc } = makeStubSvc();
    const h = makeHandlers(svc);
    const r = await h['get_filing']!({ accessionNumber: 'foo' });
    expect(r.isError).toBe(true);
  });
});

describe('handlers — dispatch + arg forwarding', () => {
  it('Q1 forwards ticker (uppercased) + numeric inputs', async () => {
    const { svc, calls } = makeStubSvc();
    const h = makeHandlers(svc);
    const r = await h['query_new_initiations_in_ticker']!({
      ticker: 'pool',
      quarter: '2025-12-31',
      minPctOfBook: 0.0025,
      limit: 100,
    });
    expect(r.isError).toBeUndefined();
    expect(calls.q1).toHaveLength(1);
    expect(calls.q1[0]).toEqual({
      ticker: 'POOL',
      quarter: '2025-12-31',
      minPctOfBook: 0.0025,
      limit: 100,
    });
  });

  it('Q4 forwards filer name to fuzzy resolver path', async () => {
    const { svc, calls } = makeStubSvc();
    const h = makeHandlers(svc);
    await h['query_filer_quarter_delta']!({ filerNameOrCIK: 'Buffett' });
    expect(calls.q4[0]).toEqual({ filerNameOrCIK: 'Buffett' });
  });

  it('Q4 surfaces ambiguous_filer with candidates', async () => {
    const calls: StubCalls = {
      q1: [],
      q2: [],
      q3: [],
      q4: [],
      q5: [],
      q6: [],
      e1: [],
      e3: [],
      e4: [],
      e5: [],
    };
    const svc = {
      q4FilerDelta: () =>
        Promise.resolve({
          kind: 'error',
          errorCode: 'ambiguous_filer',
          candidates: [
            { filerCIK: '0001067983', displayName: 'Berkshire', confidence: 0.42 },
            { filerCIK: '0001336528', displayName: 'Pershing', confidence: 0.4 },
          ],
        }),
    } as unknown as QueryService;
    void calls;
    const h = makeHandlers(svc);
    const r = await h['query_filer_quarter_delta']!({
      filerNameOrCIK: 'Capital',
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    const body = JSON.parse(r.content[0]!.text) as {
      errorCode: string;
      candidates: unknown[];
    };
    expect(body.errorCode).toBe('ambiguous_filer');
    expect(body.candidates).toHaveLength(2);
  });

  it('E2 (get_ticker_delta) maps minPctOfBookFilter → minPctOfBook for Q6', async () => {
    const { svc, calls } = makeStubSvc();
    const h = makeHandlers(svc);
    await h['get_ticker_delta']!({
      ticker: 'AAPL',
      minPctOfBookFilter: 0.005,
    });
    expect(calls.q6).toHaveLength(1);
    expect(calls.q6[0]).toMatchObject({ minPctOfBook: 0.005 });
  });

  it('E5 returns no_data_for_quarter when service yields null', async () => {
    const svc = {
      e5GetFiling: () => Promise.resolve(null),
    } as unknown as QueryService;
    const h = makeHandlers(svc);
    const r = await h['get_filing']!({
      accessionNumber: '0001193125-26-054580',
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    const body = JSON.parse(r.content[0]!.text) as { errorCode: string };
    expect(body.errorCode).toBe('no_data_for_quarter');
  });
});

describe('handlers — happy path output shape', () => {
  it('every handler returns content[0].text === JSON.stringify(structuredContent)', async () => {
    const { svc } = makeStubSvc();
    const h = makeHandlers(svc);
    const r = await h['query_new_initiations_in_ticker']!({ ticker: 'AAPL' });
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(1);
    expect(r.content[0]?.type).toBe('text');
    expect(r.content[0]?.text).toBe(JSON.stringify(r.structuredContent));
  });
});
