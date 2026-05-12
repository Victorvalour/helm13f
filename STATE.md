# Helm13F — Live State (resume bootstrap)

> **READ THIS FILE FIRST when resuming.** Single source of truth for where the
> build is. Updated on every commit. Combined with `git log --oneline -10`,
> this is enough to resume without scanning the conversation transcript.

## Current position

**Phase 3 COMPLETE (12/12 steps). Phase 4 artifacts READY.** Next: operator runs the Railway runbook in `docs/RAILWAY_DEPLOY.md`, then Phase 5 (Context registration).

| Step | Status | Commit | Tests |
|------|--------|--------|-------|
| 1. Project scaffold | ✅ | `96b0a64` | — |
| 2. EDGAR client + token bucket | ✅ | `fca4c8a` | 28 (5 rate + 23 client) |
| 3. 13F-HR XML parser | ✅ | `a3fbb1f` | 40 (18 primaryDoc + 15 infoTable + 7 valueScale) |
| 4. OpenFIGI client + CUSIP cache | ✅ | `054a0d1` | 29 (16 client + 13 cache) |
| 5. Postgres migrations + db layer | ✅ | `9f8adb6` | 23 (5 migrate + 18 repos) |
| 6. Domain logic (delta + conviction + cluster) | ✅ | `66e8e7d` | 59 (17 conviction + 22 delta + 20 cluster) |
| 7. Fuzzy filer name resolver | ✅ | `e615433` | 30 (8 levenshtein + 20 filer + 2 cluster patches) |
| 8. Ingestion pipeline | ✅ | `9973270` | 17 (7 discover + 5 parse + 5 runner) |
| 9. MCP server + 11 tools | ✅ | `9cd9c05` | 37 (9 service + 28 handler) |
| 10. Redis caching layer | ✅ | (prev commit) | 13 (8 cache + 5 wiring) |
| 11. Backfill script | ✅ | (prev commit) | 5 (planBackfill) |
| 12. End-to-end tests (docker-compose) | ✅ | (prev commit) | 16 (3 ingestion + 11 query + 2 amendment) |

**Test totals:** 358 unit tests across 22 files + 16 e2e tests across 3 files (gated behind `pnpm test:e2e`, requires `pnpm db:up`). All four gates green: lint ✓ typecheck ✓ format ✓ tests ✓.

## Phase tracker

| Phase | Status | Notes |
|-------|--------|-------|
| 0. Ground in facts | ✅ | EDGAR endpoints + 13F XML structure verified end-to-end. |
| 1. Product contract | ✅ | `docs/PRODUCT_CONTRACT.md` locked, 7 calibrations folded in. |
| 2. Schemas + migrations | ✅ | 11 tools (6 Q + 5 E), 94 contract tests, calibration 7 (ClusterEventRow). |
| 3. Implementation | ✅ | All 12 steps. 358 unit + 16 e2e tests. |
| 4. Railway deploy | ✅ artifacts; ⏳ operator action | `Dockerfile`, `railway.json`, `scripts/ingest-scheduled.ts`, `docs/RAILWAY_DEPLOY.md`. Operator runs the runbook. |
| 5. Context registration | ⏳ | Operator stakes $10 USDC, generates `CONTEXT_API_KEY` + `TOOL_ID`. |
| 6. Optimization Skill | 🛑 hard-stop | Verify deployed tool, prompt pool, wallet funding before firing. |
| 7. Grant review email | 🛑 hard-stop | Email draft reviewed before send to `grants@ctxprotocol.com`. |

## Dependencies installed

- Runtime: `@modelcontextprotocol/sdk` ^1.29, `@ctxprotocol/sdk` ^0.13, `express` ^5.2, `pg` ^8.20, `ioredis` ^5.10, `fast-xml-parser` ^5.7, `dotenv`, `ajv` + `ajv-formats`, `tsx` (moved to deps so the Docker prod install keeps the runner).
- Dev: `vitest` ^1.6, `eslint` ^9, `typescript-eslint` ^8, `prettier` ^3, `@types/{node,pg,express}`.

## Repo layout (so far)

```
/Dockerfile          multi-stage Node 20-alpine + pnpm; CMD `pnpm start`
/railway.json        Railway service config (DOCKERFILE builder, /health probe)
/.dockerignore       
/docs/RAILWAY_DEPLOY.md operator runbook for Phase 4
/migrations          001_filers_filings_holdings.sql, 002_lookup_and_cache.sql
/scripts             migrate.ts, backfill.ts, ingest-scheduled.ts (cron entrypoint)
/superinvestors      superinvestors.json (14 curated entries)
/src
  /cache             types.ts (CacheProvider + buildCacheKey + CACHE_TTL), noop.ts, redis.ts (ioredis)
  /db                pool.ts, migrate.ts, repos/{filers,filings,holdings,cusipTickerMap,deltaCache,ingestionLog}.ts
  /domain            conviction.ts, delta.ts, cluster.ts
  /ingestion         discover.ts, parse.ts, upsert.ts, runner.ts, backfill.ts
  /parser            primaryDoc.ts, infoTable.ts, valueScale.ts, types.ts
  /resolution        levenshtein.ts, filer.ts, roster.ts
  /server
    /handlers        index.ts (per-tool MCP handlers + input validation)
    /schemas         common.ts, query.ts, execute.ts, index.ts (Phase 2 source of truth)
    /service         envelope.ts, queryService.ts (business logic)
    http.ts          (Express factory + /health + /mcp + createContextMiddleware)
    main.ts          (entrypoint — wires everything)
    mcp.ts           (buildMcpServer + buildHttpTransportRegistry)
  /sources
    /edgar           rateLimiter.ts (TokenBucket), client.ts, types.ts
    /openfigi        client.ts, cache.ts (in-memory + Layered + CusipResolver)
/tests               mirrors src layout. fixtures/13f/ holds Berkshire/Scion/Pershing real XML.
  /e2e               setup.ts, mock-edgar.ts, stub-resolver.ts, *.e2e.test.ts (gated; runs against docker Postgres)
/vitest.config.ts    default config (excludes e2e from `pnpm test`)
/vitest.e2e.config.ts e2e config (run via `pnpm test:e2e`)
```

## Outstanding deferred items

- **GitHub push deferred.** `origin` is `https://github.com/Victorvalour/helm13f.git`; environment has no credentials. All commits are local. Operator handles auth (e.g. `gh auth login` or SSH remote) when ready; we'll batch-push on next operator action.

## Known design choices worth remembering

- Stub Database in tests uses a sticky-FIFO regex matcher: `responses.length > 1 ? shift() : responses[0]`. Lets a single canned response satisfy arbitrarily many calls (e.g. fetchFiler).
- `wrapTickerEnvelope` helper assembles the rich envelope; `buildEvidence` accepts a permissive partial-shape so it works across NewInitiationRow / ExitRow / ResizeRow / ClusterEventRow.
- `pctOfBook` round-trips: bigint at the DB layer, `NUMERIC(8,6)` in Postgres, `number` in envelopes (precision-safe up to 6 decimals).
- The MCP SDK's `CallToolResult` union narrowed in 1.29 to include managed-tasks; we suppress with `// @ts-expect-error` on the single setRequestHandler call. Document above the line.

## Gate commands (always pipe through `| tail -5` unless debugging)

```bash
pnpm lint          # 0 errors expected
pnpm typecheck     # 0 errors expected
pnpm format:check  # all matched files use Prettier
pnpm test          # 340/340
```

## What `step N` looks like in execution

1. Read this file + `git log --oneline -10`.
2. Read only the source files relevant to step N (use `STATE.md`'s repo layout as the map — do NOT scan everything).
3. Implement with small Edit operations, not Write.
4. Run gates with `| tail -5`.
5. **Update STATE.md** with the new commit hash + new test count.
6. Commit (Conventional Commits).
7. One-line summary in chat. Continue or stop per autonomy rules.
