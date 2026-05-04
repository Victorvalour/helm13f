# Helm13F — Schemas Guide

This document is the human-readable map between the Postgres tables (`/migrations`) and the JSON Schemas published by the MCP server (`/src/server/schemas/`). It is written for the Phase 7 grant reviewer reading the GitHub repo cold.

---

## 1. Architecture in one paragraph

Background ingestion parses 13F-HR filings from EDGAR into a normalized Postgres schema (`filers`, `filings`, `holdings`). All deltas, conviction tiers, and cluster signals are pre-computed at ingest time and stored in `delta_cache`. At request time, every Query / Execute tool reads only Postgres + Redis and returns a `structuredContent` envelope that validates against its `outputSchema`. There are zero upstream API calls at request time. The 60-second hard timeout from the Context runtime is comfortably beaten because nothing is computed live.

---

## 2. Table → schema map

### `filers` (migration 001)

The roster of every CIK we have ever seen file a 13F-HR. Joined to the curated superinvestor roster via `is_superinvestor` and `superinvestor_tier`.

| Column | Type | Maps to JSON Schema field | Notes |
|--------|------|---------------------------|-------|
| `filer_cik` | `CHAR(10)` PK | `filerCIK` (every row), `cikSchema` | 10-digit zero-padded. |
| `filer_name` | `TEXT` | `filerName` | Canonical EDGAR cover-page filer name. |
| `display_name` | `TEXT` | `filerDisplayName` (nullable) | Friendlier roster name, null when not curated. |
| `is_superinvestor` | `BOOLEAN` | `isSuperinvestor` | Paired with `superinvestor_tier` (calibration 1). |
| `superinvestor_tier` | `TEXT` | `superinvestorTier` | `'legendary' \| 'well-known' \| 'notable' \| null`. SQL `CHECK` constraint enforces the pairing invariant. |
| `aliases` | `JSONB` | `aliases[]` (E3 `list_superinvestors`) | GIN-indexed for fuzzy resolution. |
| `primary_strategy` | `TEXT` | `primaryStrategy` | `'value' \| 'event-driven' \| 'macro' \| ...`. |

**Invariant.** The `filers_superinvestor_tier_pairing` CHECK constraint guarantees `is_superinvestor = false ↔ superinvestor_tier IS NULL`. The parser/loader enforces it at write time; the JSON Schemas document it in property descriptions; the contract test suite asserts it on every fixture.

**Indexes.** `filers_normalized_name_idx`, `filers_aliases_gin_idx` (GIN for substring-in-array search), `filers_superinvestors_idx` (partial, for the curated subset).

### `filings` (migration 001)

One row per accession of form `13F-HR` or `13F-HR/A`. Cover-page metadata only; holdings are in `holdings`.

| Column | Type | Maps to JSON Schema field | Notes |
|--------|------|---------------------------|-------|
| `accession_number` | `VARCHAR(20)` PK | `accessionNumber` (E5 `get_filing`) | `0001193125-26-054580` shape. |
| `filer_cik` | `CHAR(10)` FK→filers | `filerCIK` | |
| `form` | `VARCHAR(16)` | `form` (E5) | `'13F-HR' \| '13F-HR/A'`. |
| `is_amendment` | `BOOLEAN` | `isAmendment` | True iff `form = '13F-HR/A'`. |
| `superseded_by_accession` | `VARCHAR(20)` FK→filings | `supersededByAccession` | The amendment that replaces this row (deferred FK so we can write the amendment first). |
| `period_of_report` | `DATE` | `periodOfReport`, `currentQuarter`, `priorQuarter` | Always a quarter-end. |
| `filing_date` | `DATE` | `filedAt`, `filings.recent.filingDate` | |
| `book_value_usd` | `BIGINT` | `bookValueUSD`, `currentBookValueUSD`, `priorBookValueUSD` | Normalized to dollars regardless of `value_scale`. |
| `value_scale` | `TEXT` | `meta.valueScale` | `'USD' \| 'USD_THOUSANDS'`. Even though V1 ships only post-2023 data, the parser implements both branches and is unit-tested at the boundary. |
| `table_entry_total` | `INTEGER` | `tableEntryTotal` (E5) | Count of raw `<infoTable>` rows in the InfoTable XML *before* our (cusip, putCall) aggregation. May exceed `holdings.length`. |
| `info_table_filename` | `TEXT` | (used to build `infoTableURL`) | Filer-chosen, e.g. `50240.xml` for Berkshire's most recent 13F. Discovered via `index.json` GET (calibration 2 / Phase 0 lock). |

**Indexes.** `filings_filer_period_idx`, `filings_period_idx`, `filings_amendments_idx`, `filings_active_idx` (partial: `WHERE superseded_by_accession IS NULL` — the hot read path).

### `holdings` (migration 001)

One row per `(accession, cusip, put_call)` AFTER multi-row aggregation per filing. The parser MUST aggregate by `(cusip, putCall)` before writing — see Phase 0 calibration 3 (Berkshire's 3 ALLY FINL rows → 1 logical holding).

| Column | Type | Maps to JSON Schema field | Notes |
|--------|------|---------------------------|-------|
| `accession_number` | `VARCHAR(20)` FK→filings | (provenance) | Cascade delete with filings. |
| `filer_cik` | `CHAR(10)` | `filerCIK` | Denormalized for fast filer-axis scans. |
| `period_of_report` | `DATE` | `periodOfReport` | Denormalized for fast time-axis scans. |
| `cusip` | `CHAR(9)` | `cusip` (every row) | 9 uppercase alphanumeric. |
| `ticker` | `VARCHAR(16)` | `ticker` (nullable) | Null when CUSIP unresolved → `gapSignals: ['cusip_unresolved']`. |
| `issuer_name` | `TEXT` | `issuerName` | From INFOTABLE `nameOfIssuer`. |
| `title_of_class` | `TEXT` | `titleOfClass` (E5) | From INFOTABLE `titleOfClass`. |
| `shares` | `BIGINT` | `shares`, `currentShares`, `priorShares`, `sharesNew`, `sharesExited` | Aggregated per `(cusip, put_call)`. |
| `value_usd` | `BIGINT` | `valueUSD`, `priorValueUSD`, etc. | Normalized to dollars. |
| `pct_of_book` | `NUMERIC(8,6)` | `pctOfBook`, `priorPctOfBook`, `currentPctOfBook` | Decimal in [0, 1] (4 decimal places visible in the JSON). |
| `conviction_tier` | `TEXT` | `convictionTier`, `priorConvictionTier` | Pre-computed from `pct_of_book` at ingest. |
| `ssh_prnamt_type` | `VARCHAR(8)` | `sshPrnamtType` (E5) | `'SH' \| 'PRN'`. |
| `put_call` | `VARCHAR(8)` | `putCall` (E5) | `'Put' \| 'Call' \| null`. |

**Primary key.** `(accession_number, cusip, put_call)` — the natural key after aggregation. Class-A vs Class-B (different CUSIPs) **must NOT** aggregate; the PK enforces this.

**Indexes.**
- `holdings_ticker_period_idx` (`ticker, period_of_report`) — drives Q1/Q2/Q3/Q5/Q6 ticker-axis lookups.
- `holdings_filer_period_idx` (`filer_cik, period_of_report`) — drives Q4/E1 filer-axis lookups.
- `holdings_cusip_idx` — for join into `cusip_ticker_map` and amendment recompute.
- `holdings_period_cusip_idx` — for delta cache rebuild.
- `holdings_pct_of_book_idx` (`period_of_report, pct_of_book DESC`) — supports the deterministic-sort-then-truncate pattern (calibration 5).

### `cusip_ticker_map` (migration 002)

Local cache of CUSIP→ticker. Populated from `company_tickers.json` (issuer-side) first, falls back to OpenFIGI for issuers not in the public map (depositary receipts, etc.). The `source` column lets us re-verify entries asymmetrically.

| Column | Maps to | Notes |
|--------|---------|-------|
| `cusip` PK | (resolution input) | |
| `ticker` | output `ticker` field | Nullable: explicit "no mapping known" is a valid state. |
| `source` | (audit) | `'company_tickers' \| 'openfigi' \| 'manual_override'`. |

### `delta_cache` (migration 002)

Pre-computed structured-content envelopes keyed by `(axis | quarter pair | filter fingerprint)`. Read-through cache: every Q* and E1/E2 call hits this first.

Cache key examples:
- `filer:0001067983|2025-12-31|2025-09-30`
- `ticker:AAPL|2025-12-31|2025-09-30`
- `ticker:AAPL|2025-12-31|2025-09-30|min:0.0025`

`schema_version` lets us version-bust safely when the envelope shape changes (which it can, e.g. if the Optimization Skill iteration tweaks descriptions).

### `ingestion_log` (migration 002)

Observability only; one row per ingestion run. Powers `meta.freshness.lastIngestionRunAt`, `meta.filersIngestedCount`, and the operator's 30-day uptime reporting.

---

## 3. JSON Schema layout

`/src/server/schemas/`:

| File | Exports | Purpose |
|------|---------|---------|
| `common.ts` | `Patterns`, `Enums`, scalar fragments, row schemas, `envelopeSchema(rowsSchema)`, `rowsArraySchema(...)` | Shared building blocks. Source of truth for property descriptions, units, examples. |
| `query.ts` | `Q1`–`Q6`, `QUERY_TOOLS` | Tier 1 Query tool definitions (name, description, inputSchema, outputSchema, `_meta`). |
| `execute.ts` | `E1`–`E5`, `EXECUTE_TOOLS` | Tier 1 intelligence (E1, E2) + Tier 2 discovery / raw (E3, E4, E5). |
| `index.ts` | `ALL_TOOLS` | Single export consumed by the MCP server registration code in Phase 3. |

### The Query envelope (Q1–Q6, E1, E2)

Every Query tool and the two Tier-1 Execute methods return the same envelope shape (built by `envelopeSchema()`). The runtime synthesises this single envelope into either `answer_with_evidence` or `evidence_only` per the client's `responseShape`. We do NOT ship two handlers.

**Per-tool `rows` shape:**
- Q1 / Q2 / Q3 — flat arrays of `newInitiationRowSchema` / `exitRowSchema` / `resizeRowSchema`.
- Q4 / E1 — single object with five sub-arrays (`filerDeltaRowsSchema`).
- Q5 — flat array of `clusterEventRowSchema` (calibration 7; not Q1-shape). Each row tags `clusterEventType: "new" | "add"` and exposes per-row `pctOfBookDelta`. The envelope-level invariant `clusterSignal.strength === sum(rows[i].pctOfBookDelta)` is asserted in the Q5 contract tests.
- Q6 / E2 — single object with four buckets (`tickerDeltaRowsSchema`).

Required fields:

| Field | Purpose |
|-------|---------|
| `summary` | One-paragraph human-friendly synthesis. Consumed first by `answer_with_evidence`. |
| `rows` | The actual data. Either an array (Q1/Q2/Q3/Q5) or a structured object (Q4/Q6/E1/E2). |
| `summaryStats` | `count`, `totalConvictionWeight`, `topByPctOfBookFilerCIK`. |
| `clusterSignal` | Always present, nullable (calibration 3). |
| `evidence` | `facts[]` with accession + sourceURL provenance, `sourceRefs[]`, `assumptions[]`, `unknowns[]`. |
| `freshness` | `asOf`, `currentQuarter`, `priorQuarter`, `lastIngestionRunAt`, `notes`. |
| `confidence` | `level`, `reasoning`, `factCount`, `gapSignals[]` (closed enum, calibration 2). |
| `view` | Render hint: `kind` ∈ `'table' \| 'leaderboard' \| 'timeseries' \| 'summary'`. |
| `meta` | `coverageScope`, `seasonStatus`, `filersIngestedCount`, `restatementApplied`, `valueScale`, `truncated`, `totalRowsAvailable`, `limitApplied` (calibration 5). |

`additionalProperties: false` is set on every object schema so the runtime cannot silently accept drift.

### The light envelope (E3, E4, E5)

Tier 2 discovery and raw fetch use a lighter shape (still with root `type: 'object'`):

```jsonc
{
  "rows" | (E5 fields directly): ...,
  "meta": {
    "asOf":              "ISO datetime",
    "truncated":          boolean,
    "totalRowsAvailable": integer,
    "limitApplied":       integer | null,
    "notes":              string  | null
  }
}
```

E3/E4 have `rows[]`; E5 has flat fields plus a `holdings[]` array. All three preserve `meta.asOf` for freshness honesty even though there's no Query envelope to surround them.

---

## 4. Calibration audit trail

These are the six Phase 2 calibrations from the operator, with the file/line where each lives:

1. **`isSuperinvestor × superinvestorTier` invariant** — schema description in `common.ts` (filerIdentityProps), SQL CHECK in `001_filers_filings_holdings.sql`, contract tests in `contract.test.ts` (`Calibration 1` block).
2. **`gapSignals` closed enum** — `Enums.gapSignal` in `common.ts`, baked into `confidenceSchema.gapSignals.items.enum`, asserted in `Calibration 2` test block.
3. **`clusterSignal` nullable but always present** — `clusterSignalSchema` in `common.ts`, listed in envelope `required`, asserted in `Calibration 3` test block.
4. **Phase 6 wallet-drawdown watchpoint** — runbook only; recorded in `PRODUCT_CONTRACT.md §14`, will appear in `OPTIMIZATION_ARTIFACT.json.notes.walletWatchpoint` after Phase 6.
5. **Pagination + deterministic sort** — `limit` input on every ticker- and filer-axis tool (defaults: 500 ticker-axis, 1000 filer-axis); `meta.{truncated, totalRowsAvailable, limitApplied}` required on every envelope. Asserted in `Calibration 5` test block.
6. **§18 acceptance gate addition** — `PRODUCT_CONTRACT.md §18` checkbox: "Listing description on the Context developer dashboard auto-pushed by the Optimization Skill, includes Features / Try Asking (≥7 questions) / Agent Tips."
7. **Q5 ClusterEventRow shape + cluster-strength-equals-sum invariant** — `clusterEventRowSchema` in `common.ts`, wired into Q5's `outputSchema` in `query.ts`. Row-level invariants (`new` ↔ null priors, `add` ↔ populated priors, `pctOfBookDelta = currentPctOfBook − (priorPctOfBook ?? 0)`) enforced in the parser/loader and asserted on the Q5 fixture in the `Calibration 7` test block. Envelope-level invariant `clusterSignal.strength === sum(rows[i].pctOfBookDelta)` asserted on a synthetic 5-member cluster (mix of new + add) to 6 decimal places.

---

## 5. Test coverage

`pnpm test` runs `tests/schemas/contract.test.ts` (88 assertions). Coverage:

- Structural: every tool has root `type: 'object'`, `_meta.surface = 'both'`, `queryEligible: true`, `latencyClass: 'instant'`, and a string `pricing.executeUsd`.
- Validation: synthetic payload validates against every output schema (Q1, Q2, Q3, Q4, Q5, Q6, E1, E2, E3, E4, E5).
- Calibration 1: `isSuperinvestor=true ↔ tier non-null` and `false ↔ null` fixtures pass; non-superinvestor row with null tier validates.
- Calibration 2: every recognised `gapSignal` validates; an unrecognised token is rejected.
- Calibration 3: `clusterSignal: null` validates; omitting `clusterSignal` is rejected.
- Calibration 5: `truncated=true` envelope validates; omitting `truncated` or `totalRowsAvailable` is rejected.
- Calibration 7: 5-member cluster fixture validates; unknown `clusterEventType` rejected; `strength` matches row-sum to 6 decimals; `new` rows have null priors and `add` rows have populated priors; `pctOfBookDelta = currentPctOfBook − (priorPctOfBook ?? 0)` for every row.

---

## 6. What lives outside this directory

- **Domain logic** (delta classification, conviction tiering, cluster detection): `/src/domain/` — Phase 3.
- **Filer fuzzy resolution**: `/src/resolution/filer.ts` — Phase 3.
- **EDGAR / OpenFIGI clients**: `/src/sources/edgar/`, `/src/sources/openfigi/` — Phase 3.
- **MCP server wiring** (`createContextMiddleware`, request handlers): `/src/server/index.ts` — Phase 3.

The schemas in this Phase 2 commit are the contract those Phase 3 modules implement against.
