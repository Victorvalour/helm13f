# Helm13F

Institutional-ownership delta intelligence for US equities, served as an MCP tool on the [Context Protocol marketplace](https://ctxprotocol.com).

Given a US-listed ticker or a 13F filer (CIK or fuzzy name), Helm13F returns the structured quarter-over-quarter delta of new initiations, exits, and material resizes — each weighted by percentage of the filer's reported 13F book — sourced directly from SEC EDGAR Form 13F-HR filings. Conviction tiering, delta classification, and superinvestor cluster detection are pre-computed at ingestion time so every Query and Execute call hits Postgres + Redis only, never EDGAR.

This repo is the canonical source for the live tool. It is public for grant review (Context Protocol grants program, Tier S).

---

## Status

- **Phase 0 — Ground in facts.** Done. EDGAR endpoints, schemas, and 13F-HR XML structure verified end-to-end against Berkshire CIK 1067983.
- **Phase 1 — Product contract.** Done. See [`docs/PRODUCT_CONTRACT.md`](docs/PRODUCT_CONTRACT.md).
- **Phase 2 — Schemas + migrations.** Done. 6 Query + 5 Execute tools defined; 94 contract tests passing. See [`docs/SCHEMAS.md`](docs/SCHEMAS.md).
- **Phase 3 — Implementation.** In progress.
- **Phase 4 — Railway deploy.** Done. Dockerfile + `railway.json` ready; runbook in [`docs/RAILWAY_DEPLOY.md`](docs/RAILWAY_DEPLOY.md).
- **Phase 5–7 — Register / optimize / submit.** Pending.

[`TODO.md`](TODO.md) tracks the live phase state.

---

## What it answers

Six must-win prompts (Tier 1 Query tools):

1. **New initiations on a ticker, conviction-weighted.** Which managers newly bought $TICKER last quarter, and how big as a percentage of each manager's book?
2. **Exits from a ticker, conviction-weighted.** Which managers fully exited $TICKER, and how meaningful was the position they sold?
3. **Material resizes (≥25%) on a ticker.** Which managers added or trimmed by ≥25%?
4. **Single-filer dual-quarter delta.** What did Burry / Buffett / Ackman / $MANAGER change between two quarters? (Fuzzy name resolution included.)
5. **Superinvestor cluster on a ticker.** Did 3+ well-known managers cluster-buy $TICKER last quarter? Returns a `weak | notable | strong` tier plus per-event rows.
6. **Full ticker delta picture.** Composite of #1+#2+#3 in one structured envelope, bucketed by deltaType.

Plus five Execute methods (programmatic counterparts + discovery layer):

- `get_filer_delta` (CIK in → full delta out, no fuzzy resolution)
- `get_ticker_delta` (ticker in → bucketed delta out)
- `list_superinvestors` (curated ~150 roster + filters)
- `list_quarters_available` (which periodOfReports we have ingested)
- `get_filing` (accession in → cover page + aggregated holdings)

Full input/output contracts: [`docs/PRODUCT_CONTRACT.md §8`](docs/PRODUCT_CONTRACT.md).

---

## Architecture

```
SEC EDGAR  ─►  Token-bucket-rate-limited fetcher  ─►  13F-HR XML parser
                       (10 req/s shared)                (cover + InfoTable)
                                                              │
                                                              ▼
                                                      Postgres normalised
                                                      (filers, filings, holdings)
                                                              │
        ┌───────────────────── delta_cache (pre-computed envelopes) ◄─── Domain logic
        ▼                                                       (delta / conviction / cluster)
  Redis hot cache  ─►  MCP server (Express + @modelcontextprotocol/sdk
                                + @ctxprotocol/sdk createContextMiddleware)
                                                              │
                                                              ▼
                                                Context Protocol marketplace
                                                  (Query + Execute surfaces)
```

Zero upstream API calls at request time. Background ingestion is the only thing that hits EDGAR.

Latency targets: **p50 < 1s, p95 < 3s, p99 < 10s**, hard cap 60s (Context runtime kill).

---

## The five reviewer-named capabilities

1. **Delta classification.** `new | exit | add | trim | unchanged`, deterministic at ingestion. Aggregated by `(cusip, putCall)` per filing before delta math.
2. **Conviction tiering.** `core ≥5% | meaningful 1–5% | starter 0.25–1% | scout <0.25%`, computed off `pctOfBook = value / tableValueTotal`.
3. **Fuzzy filer name resolution.** Levenshtein + token-overlap + alias roster. `"Burry" → 0001649339`, `"Ackman" → 0001336528`, ambiguous names return `errorCode: "ambiguous_filer"` with top-3 candidates.
4. **Amendment handling.** `13F-HR/A` flips `isAmendment=true`, marks the prior accession superseded, recomputes deltas, and surfaces `meta.restatementApplied: true` in any response materially affected.
5. **Superinvestor cluster detection.** 3+ curated-roster filers with `new` or `add` events on a ticker form a cluster (`weak 3-4 | notable 5-7 | strong ≥8`); strength is the sum of per-row `pctOfBookDelta`. Asserted as an envelope-level invariant in the Q5 contract tests.

Where each capability lives in the codebase: [`docs/PRODUCT_CONTRACT.md §10`](docs/PRODUCT_CONTRACT.md).

---

## Coverage scope

- **In:** Long US equity holdings disclosed via Form 13F-HR / 13F-HR/A INFOTABLE rows. Equity options preserved (`putCall` field).
- **Out:** Short positions, 13D/13G beneficial-ownership, Form 4 insider transactions, multi-quarter trends >2 quarters back, predictive recommendations, non-US filings, private fund holdings not on Form 13F.

Out-of-scope queries return a structured `not_in_scope` error, never a silent approximation.

---

## Repo layout

```
/migrations            — SQL migrations (Postgres 15+)
/src
  /server/schemas      — JSON Schemas for all 11 tools (single source of truth)
  /server              — MCP server, request handlers (Phase 3.9)
  /ingestion           — Background ingestion pipeline (Phase 3.8)
  /db                  — Postgres query layer (Phase 3.5)
  /cache               — Redis wrapper (Phase 3.10)
  /sources/edgar       — EDGAR client + token-bucket rate limiter (Phase 3.2)
  /sources/openfigi    — OpenFIGI client + CUSIP cache (Phase 3.4)
  /domain              — Pure delta / conviction / cluster logic (Phase 3.6)
  /resolution          — Filer fuzzy resolver (Phase 3.7)
/scripts               — Backfill, manual ingestion (Phase 3.11)
/superinvestors        — superinvestors.json roster + maintenance scripts
/tests                 — Vitest unit + e2e suites
/docs                  — PRODUCT_CONTRACT.md, SCHEMAS.md, OPTIMIZATION_ARTIFACT.json (Phase 6)
```

---

## Local development

```bash
pnpm install
cp .env.example .env.local        # fill in EDGAR_USER_AGENT, DATABASE_URL, REDIS_URL
pnpm db:up                        # docker-compose Postgres + Redis
pnpm migrate                      # apply SQL migrations
pnpm test                         # 358 unit tests (no docker required)
pnpm test:e2e                     # 16 e2e tests (docker required)
pnpm typecheck
pnpm lint
pnpm dev                          # `tsx watch` on the MCP server
```

## Production deployment

Railway, with bundled Postgres + Redis plugins. End-to-end runbook:
**[`docs/RAILWAY_DEPLOY.md`](docs/RAILWAY_DEPLOY.md)**. TL;DR:

```bash
railway init && railway add --plugin postgres && railway add --plugin redis
railway variables set EDGAR_USER_AGENT="Helm13F <name> <email>"
railway up
railway run pnpm migrate
railway run pnpm backfill -- --quarters=4
```

The image (`Dockerfile`) is multi-stage Node 20-alpine + pnpm. Two
services share it: the MCP web server (`pnpm start`, healthchecked at
`/health`) and the scheduled ingestion runner (`pnpm ingest:scheduled`,
cron-driven, daily Feb/May/Aug/Nov + weekly off-season per Phase 0
calibration 4).

---

## License

MIT. See [`LICENSE`](LICENSE) (added in Phase 4).

---

## Contributing / questions

This is a grant-funded single-builder project. Issues and PRs welcome once the tool is live on Context.
