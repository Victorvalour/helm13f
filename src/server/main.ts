// Entrypoint — wires every dependency together and starts the HTTP server.
// Run via `pnpm start` (production) or `pnpm dev` (watch mode).

import 'dotenv/config';
import { createPgDatabase } from '../db/index.js';
import { EdgarClient } from '../sources/edgar/index.js';
import {
  CusipResolver,
  InMemoryCusipCache,
  LayeredCusipCache,
  OpenFigiClient,
} from '../sources/openfigi/index.js';
import { CusipTickerMapRepo } from '../db/repos/cusipTickerMap.js';
import { FilerResolver, loadRoster } from '../resolution/index.js';
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

  const svc = new QueryService({ db, resolver, rosterByCik });
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
