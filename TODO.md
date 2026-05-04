# Helm13F — Build Tracker

| Phase | Status | Notes |
|-------|--------|-------|
| 0. Ground in facts (Context docs, EDGAR, sample filings) | ✅ done | Berkshire CIK 1067983 / accession 0001193125-26-054580 verified end-to-end. |
| 1. Endpoint discovery + Product Contract | ✅ done | See `docs/PRODUCT_CONTRACT.md`. |
| 2. Design (DB schema + tool I/O schemas) | ✅ done | Migrations in `/migrations`, schemas in `/src/server/schemas`, 94/94 contract tests green. |
| 3. Implementation | 🚧 in progress | 12 numbered steps; running with autonomy from operator. |
| 4. Deployment (**Railway** — not Fly.io) | ⏳ blocked by Phase 3 | Railway bundled Postgres + Redis addons; `railway.json`, not `fly.toml`. |
| 5. Register on Context | ⏳ blocked by Phase 4 | Operator stakes $10 USDC, generates `CONTEXT_API_KEY` + `TOOL_ID`. |
| 6. Optimization Skill | 🛑 hard stop pre-firing | Verify deployed tool, candidate prompt pool, wallet funding before firing. Target: ≥95% pass rate AND ≥7 high-differentiation prompts. |
| 7. Grant review request | 🛑 hard stop pre-send | Email draft reviewed and approved before send. |

## Phase 3 step tracker

| # | Step | Status | Notes |
|---|------|--------|-------|
| 1 | Project scaffold (eslint, prettier, README, .env.example) | ✅ `96b0a64` | All four gates green. |
| 2 | EDGAR client + token-bucket rate limiter | 🚧 in progress | |
| 3 | 13F-HR INFOTABLE XML parser | ⏳ | |
| 4 | OpenFIGI client + CUSIP cache | ⏳ | |
| 5 | Postgres migrations runner + db query layer | ⏳ | docker-compose for local Postgres + Redis lands here. |
| 6 | Domain logic (delta / conviction / cluster) | ⏳ | Pure functions; boundary unit-tested. |
| 7 | Fuzzy filer name resolver | ⏳ | |
| 8 | Ingestion pipeline | ⏳ | |
| 9 | MCP server + 11 tools registered | ⏳ | `createContextMiddleware()` on `/mcp`. |
| 10 | Redis caching layer | ⏳ | |
| 11 | Backfill script | ⏳ | Last 4 quarters × ~150 superinvestors. |
| 12 | End-to-end tests | ⏳ | docker-compose. |

## Locked concerns (carried forward from Phase 0)

1. `valueScale: "USD" | "USD_THOUSANDS"` enum on every parsed filing; pre-2023 boundary unit-tested.
2. Filer-named INFOTABLE XML — discover via `index.json`, never string-construct.
3. Multi-row-per-CUSIP aggregation by `(cusip, putCall)` per filing **before** delta math.
4. Cadence: daily Feb/May/Aug/Nov, weekly off-season.
5. `_meta.surface: "both"` — code comment will document the docs-inconsistency.
6. EDGAR fetched via Node native `fetch` + `User-Agent` header; one rate-limited client.
7. Q5 ClusterEventRow shape; envelope-level invariant `clusterSignal.strength === sum(rows[i].pctOfBookDelta)`.

## Workflow (operator-set, post step-1)

- Autonomous through steps 2–12 of Phase 3 + Phase 4 (Railway) + Phase 5 (Context registration).
- Hard-stop checkpoints: pre-Phase-6 (Optimization Skill firing), pre-Phase-7 (review email send).
- Routine completions: commit, push, update this tracker, brief one-liner in chat.
- Stop only on: contract contradiction, unresolvable test failure, external-service block, or a discovery that materially changes the build plan.

## Optimization target (locked above grant floor)

PASS = `passRate ≥ 0.95` AND `highDifferentiationCount ≥ 7`.
