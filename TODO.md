# Helm13F — Build Tracker

| Phase | Status | Notes |
|-------|--------|-------|
| 0. Ground in facts (Context docs, EDGAR, sample filings) | ✅ done | Berkshire CIK 1067983 / accession 0001193125-26-054580 verified end-to-end. |
| 1. Endpoint discovery + Product Contract | ✅ done | See `docs/PRODUCT_CONTRACT.md`. |
| 2. Design (DB schema + tool I/O schemas) | ✅ done | Migrations in `/migrations`, schemas in `/src/server/schemas`, contract tests 88/88 green. Awaiting approval to start Phase 3. |
| 3. Implementation (12 numbered steps) | ⏳ pending approval | Build order locked in original prompt. |
| 4. Deployment (Fly.io) | ⏳ blocked by Phase 3 | Operator runs `flyctl`; we provide commands + env checklist. |
| 5. Register on Context | ⏳ blocked by Phase 4 | Operator stakes $10 USDC, generates `CONTEXT_API_KEY` + `TOOL_ID`. |
| 6. Optimization Skill | ⏳ blocked by Phase 5 | Target: ≥95% pass rate AND ≥7 high-differentiation prompts. |
| 7. Grant review request | ⏳ blocked by Phase 6 | Email to grants@ctxprotocol.com with `OPTIMIZATION_ARTIFACT.json`. |

## Locked concerns (carried forward from Phase 0)

1. `valueScale: "USD" | "USD_THOUSANDS"` enum on every parsed filing; pre-2023 boundary unit-tested.
2. Filer-named INFOTABLE XML — discover via `index.json`, never string-construct.
3. Multi-row-per-CUSIP aggregation by `(cusip, putCall)` per filing **before** delta math.
4. Cadence: daily Feb/May/Aug/Nov, weekly off-season.
5. `_meta.surface: "both"` — code comment will document the docs-inconsistency.
6. EDGAR fetched via Node native `fetch` + `User-Agent` header; one rate-limited client.

## Optimization target (locked above grant floor)

PASS = `passRate ≥ 0.95` AND `highDifferentiationCount ≥ 7`.
