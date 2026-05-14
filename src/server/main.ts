// Entrypoint — wires every dependency together and starts the HTTP server.
// Run via `pnpm start` (production) or `pnpm dev` (watch mode).

import 'dotenv/config';
import { join } from 'node:path';
import { createPgDatabase, migrate } from '../db/index.js';
import { EdgarClient } from '../sources/edgar/index.js';
import {
  CusipResolver,
  InMemoryCusipCache,
  LayeredCusipCache,
  OpenFigiClient,
} from '../sources/openfigi/index.js';
import { CusipTickerMapRepo } from '../db/repos/cusipTickerMap.js';
import { FilerResolver, loadRoster } from '../resolution/index.js';
import { NoopCache, RedisCache, type CacheProvider } from '../cache/index.js';
import { QueryService } from './service/queryService.js';
import { makeHandlers } from './handlers/index.js';
import { buildMcpServer } from './mcp.js';
import { buildHttpApp } from './http.js';

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  const edgarUserAgent = process.env['EDGAR_USER_AGENT'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!edgarUserAgent) throw new Error('EDGAR_USER_AGENT is required');

  const db = createPgDatabase({ connectionString: databaseUrl });

  // Boot-migration: run pending migrations idempotently inside the
  // deployed container, where the internal DNS for the Postgres plugin
  // resolves. Removes the need for a separate `railway run pnpm migrate`
  // step — and the migrations table dedupes so re-runs are safe.
  if (process.env['SKIP_BOOT_MIGRATE'] !== 'true') {
    console.log('boot: applying migrations...');
    const applied = await migrate(db, {
      dir: join(process.cwd(), 'migrations'),
      logger: (e) => {
        if (e.kind === 'apply') console.log(`  apply ${e.name ?? ''}`);
      },
    });
    console.log(`boot: migrations done (${applied.length} applied)`);
  }

  const roster = await loadRoster();
  const rosterByCik = new Map(roster.map((r) => [r.cik, r]));
  const resolver = new FilerResolver(roster);

  // CUSIP resolution stack: Postgres-backed cache as `near`, in-memory LRU
  // as the hot-path layer. OpenFIGI fallback is optional; when no API key
  // is set the resolver returns null-ticker stubs for unknown CUSIPs.
  const memCache = new InMemoryCusipCache();
  const pgCache = new CusipTickerMapRepo(db);
  const layered = new LayeredCusipCache(memCache, pgCache);
  const figiKey = process.env['OPENFIGI_API_KEY'];
  const figi = figiKey ? new OpenFigiClient({ apiKey: figiKey }) : null;
  const cusipResolver = new CusipResolver(layered, figi);

  // EdgarClient is unused by the request path (zero upstream calls at
  // request time per the contract) but constructed here so the runtime
  // can validate the user-agent fail-fast on boot.
  void new EdgarClient({ userAgent: edgarUserAgent });
  void cusipResolver; // referenced by the ingestion runner (separate process).

  // Hot cache: Redis when REDIS_URL set, otherwise a no-op pass-through
  // (still correct, just no speedup). Key-prefix carries a version tag —
  // bumping it abandons stale entries from earlier deploys without
  // requiring FLUSHDB. v2 evicts the negative-cached null filings from
  // the empty-DB period before backfill landed.
  const redisUrl = process.env['REDIS_URL'];
  const cache: CacheProvider = redisUrl
    ? new RedisCache({ url: redisUrl, keyPrefix: 'helm13f:v2:' })
    : new NoopCache();

  const svc = new QueryService({ db, resolver, rosterByCik, cache });
  const handlers = makeHandlers(svc);
  const app = buildHttpApp({
    buildServer: () => buildMcpServer({ handlers }),
  });

  const port = parseInt(process.env['PORT'] ?? '8080', 10);
  app.listen(port, () => {
    console.log(`helm13f mcp server listening on :${port}`);
  });
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
