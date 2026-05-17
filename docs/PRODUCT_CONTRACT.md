# Helm13F — Product Contract

**Status:** Phase 1 (locked after Phase 0 approval, 2026-05-03).
**Surface tier:** Tier S grant approval (Context Protocol grants program).
**Scope discipline:** Anything not enumerated below is explicitly **out of scope**. The grant was approved on a narrow contract; we ship that contract.

---

## 1. One-line product summary

Helm13F is institutional-ownership delta intelligence for US equities. Given a US-listed ticker or a 13F filer (CIK or fuzzy name), it returns the structured quarter-over-quarter delta of new initiations, exits, and material resizes — each weighted by percentage of the filer's reported 13F book — sourced directly from SEC EDGAR Form 13F-HR filings.

## 2. Target paying user

Three buyer archetypes who currently pay for this workflow elsewhere:

1. **Discretionary equity PMs / analysts** subscribing to WhaleWisdom Premium ($300–$500/yr) or Capital IQ institutional-ownership modules ($20K+/yr/seat) for the "who initiated / who exited / how concentrated" workflow.
2. **Quant / multi-manager research engineers** writing scrapers against EDGAR or paying sec-api.io ($499+/mo) to reproduce conviction-weighted deltas. Helm13F replaces the scraper they would otherwise maintain.
3. **Agent builders on Context** (the demand-side flywheel) routing portfolio-positioning questions through marketplace tools rather than hand-curated data pipelines.

The wedge over both groups is **pre-computed conviction weighting (% of filer's book)** and **agent-native single-call access** — not a dashboard. The premium feature is *deterministic, accession-traceable conviction-weighted deltas across a curated superinvestor universe*, not raw 13F access.

## 3. Output surface model

- **Query (primary, Tier 1, 6 tools)** — Pay-per-response. Each tool answers one of the six must-win prompts and returns a single rich `structuredContent` envelope. The Context runtime synthesises that envelope into either `answer_with_evidence` or `evidence_only` per the *client's* `responseShape` choice. We ship **one envelope**; we do not ship two response handlers.
- **Execute (secondary, mix of Tier 1 + Tier 2, 5 methods)** — Per-call pricing for SDK consumers. Two intelligence methods (mirror Q4 / Q6) plus three discovery / raw-data methods that satisfy the Builder Template's mandatory Discovery Layer audit (list-all + browse-by + raw-fetch).

Both surfaces share the same Postgres + Redis serving layer. Zero upstream API calls at request time.

## 4. Tool inventory

### Query tools (Tier 1)

| ID | Tool name | Question answered | Alpha category |
|----|-----------|-------------------|----------------|
| Q1 | `query_new_initiations_in_ticker` | Which managers newly bought $TICKER last quarter, weighted by % of book? | Conviction-weighted delta detection |
| Q2 | `query_exits_from_ticker` | Which managers fully exited $TICKER last quarter, and how meaningful was the position? | Conviction-weighted delta detection |
| Q3 | `query_material_resizes_in_ticker` | Which managers added or trimmed ≥25% of their $TICKER position last quarter? | Quantitative threshold + per-filer aggregation |
| Q4 | `query_filer_quarter_delta` | What did $MANAGER's fund change between two quarters? | Fuzzy filer resolution + dual-quarter delta |
| Q5 | `query_superinvestor_cluster_on_ticker` | Did a cluster of well-known managers buy $TICKER last quarter? | Curated roster + cross-filer clustering |
| Q6 | `query_full_ticker_delta_picture` | Full delta picture (new / exit / add / trim) for $TICKER last quarter, conviction-weighted. | Composite delta + provenance |

### Execute methods (Tier 1 intelligence + Tier 2 discovery/raw)

| ID | Method | Tier | Purpose |
|----|--------|------|---------|
| E1 | `get_filer_delta` | T1 | Programmatic equivalent of Q4 — full filer delta given filerCIK. |
| E2 | `get_ticker_delta` | T1 | Programmatic equivalent of Q6 — ticker-level delta across all filers. |
| E3 | `list_superinvestors` | T2 | Curated roster (~150) with CIK, displayName, aliases, superinvestorTier, primaryStrategy. |
| E4 | `list_quarters_available` | T2 | Ingested `periodOfReport` rows with per-quarter `filersIngestedCount` and freshness. |
| E5 | `get_filing` | T2 | Given an accession number, return parsed coverPage + holdings. |

E3 + E4 + E5 satisfy the Builder Template's **Discovery Layer audit**: agents can enumerate the universe (E3), enumerate the time axis (E4), and drill into raw evidence (E5). Without these, agents have no way to *discover* what to ask.

## 5. The six must-win Query prompts

Wording below is the canonical reference question we test against during the Optimization Skill run. Synonymous phrasings must also work; these are the lighthouse cases.

**Q1 — New initiations on a ticker (conviction-weighted)**
> "Which institutional managers newly initiated a position in `$TICKER` in the most recent 13F filing season, and how big was each new position as a percentage of that manager's reported 13F book?"

**Q2 — Exits from a ticker (conviction-weighted)**
> "Which managers fully exited their `$TICKER` position in last quarter's 13Fs, and how large was the position they sold relative to their book the quarter before?"

**Q3 — Material adds and trims**
> "Show me material adds and trims in `$TICKER` for last quarter's 13Fs, where the change was at least 25% of the prior position size."

**Q4 — Single-filer quarter delta (with fuzzy name resolution)**
> "What changes did `$MANAGER_NAME`'s fund make to their 13F portfolio between `$PRIOR_QUARTER` and `$CURRENT_QUARTER`?"
> Examples: "Burry" → Scion (CIK 0001649339); "Buffett" → Berkshire (0001067983); "Ackman" → Pershing Square (0001336528).

**Q5 — Superinvestor cluster detection**
> "Did any group of well-known managers cluster-buy `$TICKER` in last quarter's 13Fs?"

**Q6 — Full delta picture (composite)**
> "Give me the full 13F delta picture on `$TICKER` for last quarter — new buys, exits, big adds, big trims, all weighted by conviction."

## 6. Candidate prompt pool for the Optimization Skill (target ≥7 high-differentiation)

Designed in Phase 1 (not deferred to Phase 6) to satisfy the upgraded target: **PASS overall status with ≥95% pass rate AND ≥7 high-differentiation prompts**. Each prompt links to an alpha category the Skill's Phase 1 gate enforces.

| # | Prompt seed | Alpha category | Why it beats free chat |
|---|-------------|----------------|------------------------|
| P1 | Q1 (new initiations) | Conviction-weighted delta | Free LLMs do not have current per-filer book values or current-quarter holdings; they cannot compute pctOfBook. |
| P2 | Q2 (exits) | Conviction-weighted delta | Requires prior-quarter holdings + current-quarter absence; LLMs hallucinate or refuse. |
| P3 | Q3 (≥25% resizes) | Quantitative threshold | LLMs cannot enforce a numeric threshold against real share counts. |
| P4 | Q4 with fuzzy "Burry" | Fuzzy filer resolution + dual-quarter delta | LLMs hallucinate Burry's holdings; we resolve the name to CIK 0001649339 and return real EDGAR-sourced deltas. |
| P5 | Q5 (cluster) | Curated roster + cross-filer math | Requires the maintained ~150-name roster; LLMs cannot enumerate it. Q5 returns its own per-event row shape (`ClusterEventRow`, see §8) distinguishing `new` initiations from material `add`s and exposing per-row `pctOfBookDelta`. |
| P6 | Q6 (composite) | Composite delta + provenance | LLMs return prose, not structured deltas with accession numbers. |
| P7 | Multi-class disambiguation: "How did BRK-A vs BRK-B institutional ownership change last quarter?" | Multi-share-class CUSIP disambiguation | LLMs conflate Class A/B; we keep them on separate CUSIPs with separate deltas. |
| P8 | Amendment awareness: "Show me the most recent quarter's 13F-HR/A amendments and what changed." | Restatement handling | LLMs do not know which filings were restated; we mark `restatementApplied`. |
| P9 | Discovery: "Which superinvestors run the most concentrated portfolios this quarter (lowest holding count, highest top-position pctOfBook)?" | Roster-aware ranking via `list_superinvestors` + per-filer book | LLMs cannot enumerate the curated roster or compute concentration. |

Nine candidates → reviewer keeps the strongest 7+. P7 + P8 are the new high-differentiation prompts beyond the original six and are specifically designed to push past the ≥7 high-differentiation bar.

## 7. Output envelope (rich `structuredContent`)

Every Query tool returns `{ content: [...], structuredContent: <envelope> }` where the envelope has this shape (camelCase, deterministic, machine-renderable). The shape is rich enough that **`evidence_only` synthesis is informative without prose**, per the Phase 0 instruction.

```jsonc
{
  // 1. Top-level human-friendly summary string. Synthesisers rank this first.
  "summary": "12 managers initiated AAPL last quarter; cluster strength notable (5 superinvestors, 3.2pp combined book weight). Top: ...",

  // 2. The actual answer rows. Schema differs per tool — see §8.
  "rows": [ /* tool-specific items */ ],

  // 3. Aggregate stats over `rows`.
  "summaryStats": {
    "count": 12,
    "totalConvictionWeight": 0.0832,   // sum of pctOfBook (decimal, not %)
    "topByPctOfBookFilerCIK": "0001067983"
  },

  // 4. Cluster signal — ALWAYS PRESENT in every Query tool's envelope as a
  //    nullable property. Stable shape across tools. Q5/Q6 may populate;
  //    Q1/Q2/Q3/Q4 always emit `null`. Never omit.
  "clusterSignal": {
    "detected": true,
    "tier": "notable",                  // weak | notable | strong
    "memberCount": 5,
    "memberCIKs": ["0001067983", "..."],
    "strength": 0.0432                  // sum of pctOfBook deltas across cluster
  },

  // 5. Evidence — every cited fact traces back to an EDGAR filing.
  "evidence": {
    "facts": [
      {
        "claim": "Berkshire initiated POOL with 0.18% of book",
        "filerCIK": "0001067983",
        "accessionNumber": "0001193125-26-054580",
        "sourceURL": "https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml",
        "filedAt": "2026-02-17"
      }
    ],
    "sourceRefs": [ /* deduped accession URLs */ ],
    "assumptions": [
      "Long US equity disclosures only; 13F-HR does not include short positions or 13D/13G holdings."
    ],
    "unknowns": []
  },

  // 6. Freshness — runtime uses this to decide caching and synthesise "as of".
  "freshness": {
    "asOf": "2026-05-03T00:00:00Z",     // ingestion completion timestamp
    "currentQuarter": "2025-12-31",     // periodOfReport ISO date
    "priorQuarter": "2025-09-30",
    "lastIngestionRunAt": "2026-05-03T03:14:00Z",
    "notes": "Q4 2025 filing season concluded 2026-02-17."
  },

  // 7. Confidence — explicit gap signals from a closed taxonomy (machine-discriminable).
  "confidence": {
    "level": "high",                    // high | moderate | low
    "reasoning": "All 12 managers in answer have parsed Q4 2025 filings.",
    "factCount": 12,
    "gapSignals": []                    // closed enum, see below
  },
  //   gapSignals[] enum (closed):
  //   - "fuzzy_match_below_threshold"        — Q4: filer name match confidence below cutoff; result may not be the intended filer
  //   - "missing_prior_quarter_for_filer"    — no parsed prior-quarter filing for this filer; deltas may be incomplete
  //   - "missing_current_quarter_for_filer"  — no parsed current-quarter filing for this filer
  //   - "cusip_unresolved"                   — one or more CUSIPs in the result lack a ticker mapping
  //   - "amendment_pending"                  — a 13F-HR/A is known to be in flight but not yet parsed

  // 8. View hints — runtime uses for table rendering in the Context app.
  "view": {
    "kind": "table",                    // table | leaderboard | timeseries | summary
    "primaryColumn": "filerName",
    "weightColumn": "pctOfBook"
  },

  // 9. Coverage scope + season status + truncation signal.
  //    `meta.truncated` is a top-level honest signal of incompleteness, NOT an error;
  //    it MUST be present on every envelope (default `false`). When true,
  //    `totalRowsAvailable` reports how many rows existed before the limit applied.
  //    Truncation is deterministic: rows are sorted by pctOfBook descending so a
  //    limit returns the most material movers first.
  "meta": {
    "coverageScope": "long_us_equity",
    "seasonStatus": "complete",         // complete | in_progress | between_seasons
    "filersIngestedCount": 4823,
    "restatementApplied": false,
    "valueScale": "USD",                // USD | USD_THOUSANDS — see §13(1)
    "truncated": false,
    "totalRowsAvailable": 12,
    "limitApplied": 500
  }
}
```

The ENVELOPE wrapper itself is what each tool's `outputSchema` describes (root `type: "object"`). The per-tool variation lives inside `rows.items.properties`.

**Envelope-level invariant (calibration 7).** For Q5 specifically, `clusterSignal.strength` MUST equal the sum of `rows[i].pctOfBookDelta` across the returned cluster-event rows (modulo floating-point at the 6th decimal). The handler computes both off the same domain layer; the contract test suite asserts the equality on every Q5 fixture.

## 8. Per-tool input/output contracts

**Conventions**
- `cik` is always 10-digit zero-padded string (`"0001067983"`), per data.sec.gov convention.
- `cusip` is always 9 characters, uppercase alphanumeric.
- `quarter` is the `periodOfReport` as ISO date (`"YYYY-MM-DD"`), always a quarter-end (`-03-31`, `-06-30`, `-09-30`, `-12-31`).
- `valueUSD`, `bookValueUSD` are integers in dollars (post-2023 EDGAR regime; see §13(1)).
- `pctOfBook` is a fraction in [0, 1] with 4 decimal places (i.e. 5% = 0.0500), **not** a percentage. Synthesisers format as % at the prose layer.
- `convictionTier` ∈ `"core" | "meaningful" | "starter" | "scout"`.
- `deltaType` ∈ `"new" | "exit" | "add" | "trim" | "unchanged"`.
- `superinvestorTier` ∈ `"legendary" | "well-known" | "notable" | null`.
- `clusterTier` ∈ `"weak" | "notable" | "strong" | null`.

**Invariant — `isSuperinvestor` × `superinvestorTier`** (every row schema): `isSuperinvestor === false` ↔ `superinvestorTier === null`. Always paired; never desynchronised. The published `outputSchema` documents this in property descriptions; the parser/loader enforces it at write time; contract tests assert it on every fixture. (We don't ship JSON-Schema `if/then` because the Context runtime validator's support is unverified — keeping the schema portable.)

**Pagination & deterministic ordering** (calibration 5):
- Every Query tool with a tickered or filered axis takes an optional `limit?: number`.
  - **Defaults:** Q1 / Q2 / Q3 / Q5 / Q6 / E2 = `500`. Q4 / E1 = `1000`. Q5 is naturally bounded by the curated roster (~150) but accepts `limit` for shape consistency.
- Rows are sorted by `pctOfBook` **descending** (most-conviction first), so any `limit` returns the most material movers.
- `meta.truncated`, `meta.totalRowsAvailable`, `meta.limitApplied` MUST be present on every envelope (`truncated=false` when no truncation occurred).

### Q1 `query_new_initiations_in_ticker`
**Input:** `{ ticker: string, quarter?: string, minPctOfBook?: number, limit?: number /* default 500 */ }` (v1: scoped to curated 22-manager universe; non-roster filer ingestion is a roadmap item)

**Row shape:**
```jsonc
{
  "filerCIK": "0001067983",
  "filerName": "BERKSHIRE HATHAWAY INC",         // EDGAR canonical
  "filerDisplayName": "Berkshire Hathaway",      // our roster, may be friendlier
  "isSuperinvestor": true,
  "superinvestorTier": "legendary",
  "primaryStrategy": "value",
  "ticker": "POOL",
  "issuerName": "POOL CORP",
  "cusip": "73278L105",
  "sharesNew": 404057,
  "valueUSD": 122334566,
  "pctOfBook": 0.0018,
  "convictionTier": "starter",
  "bookValueUSD": 274160086701,
  "currentQuarterAccessionNumber": "0001193125-26-054580",
  "sourceURL": "https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml",
  "filedAt": "2026-02-17"
}
```

### Q2 `query_exits_from_ticker`
**Input:** same as Q1.
**Row shape:** identical to Q1 except `sharesNew` → `sharesExited`, plus `priorQuarterAccessionNumber` and `priorPctOfBook` (the conviction *before* exit). `currentQuarterAccessionNumber` references the filing where the holding is now absent.

### Q3 `query_material_resizes_in_ticker`
**Input:** `{ ticker: string, quarter?: string, minDeltaPct?: number /* default 0.25 */, limit?: number /* default 500 */ }`
**Row shape:** Q1 fields plus:
```jsonc
{
  "deltaType": "add",                  // add | trim
  "priorShares": 1000000,
  "currentShares": 1500000,
  "shareDeltaPct": 0.50,
  "priorPctOfBook": 0.0040,
  "currentPctOfBook": 0.0062,
  "pctOfBookDelta": 0.0022,
  "priorQuarterAccessionNumber": "...",
  "currentQuarterAccessionNumber": "..."
}
```

### Q4 `query_filer_quarter_delta`
**Input:** `{ filerNameOrCIK: string, currentQuarter?: string, priorQuarter?: string, includeUnchanged?: boolean, limit?: number /* default 1000, applied per sub-array */ }`

If `filerNameOrCIK` is not a CIK pattern, run fuzzy resolution. If confidence < threshold, return `{ isError: true, content: [...] }` with `errorCode: "ambiguous_filer"` and a `candidates` array (top 3 with confidence scores).

**Envelope `rows`:** five sub-arrays:
```jsonc
{
  "filerCIK": "0001649339",
  "filerName": "SCION ASSET MANAGEMENT, LLC",
  "filerDisplayName": "Scion Asset Management",
  "currentQuarter": "2025-12-31",
  "priorQuarter": "2025-09-30",
  "currentBookValueUSD": 89000000,
  "priorBookValueUSD": 76000000,
  "newInitiations": [ /* Q1-row-shape items */ ],
  "exits":          [ /* Q2-row-shape items */ ],
  "addedTo":        [ /* Q3-row-shape items, deltaType="add" */ ],
  "trimmedFrom":    [ /* Q3-row-shape items, deltaType="trim" */ ],
  "unchanged":      [ /* compact: cusip, ticker, currentShares, currentPctOfBook */ ]
}
```

### Q5 `query_superinvestor_cluster_on_ticker`
**Input:** `{ ticker: string, quarter?: string, limit?: number /* default 500 */ }`
**Envelope `rows`:** array of `ClusterEventRow` items (calibration 7 — Q5 has its own row shape, not Q1-shape). `clusterSignal` is the primary payload; the row array is the per-member breakdown.

**`ClusterEventRow` shape:**
```jsonc
{
  // Filer + issuer identity (same as Q1 row)
  "filerCIK": "0001067983",
  "filerName": "BERKSHIRE HATHAWAY INC",
  "filerDisplayName": "Berkshire Hathaway",
  "isSuperinvestor": true,
  "superinvestorTier": "legendary",
  "primaryStrategy": "value",
  "ticker": "POOL",
  "issuerName": "POOL CORP",
  "cusip": "73278L105",
  "convictionTier": "starter",            // current-quarter tier (post-event)

  // Cluster-event-specific fields:
  "clusterEventType": "new",              // "new" | "add"
  "sharesAttributed": 404057,             // for "new": full position size; for "add": currentShares - priorShares
  "priorPctOfBook": null,                 // null for "new", number for "add"
  "currentPctOfBook": 0.0018,
  "pctOfBookDelta": 0.0018,               // currentPctOfBook - (priorPctOfBook ?? 0)
  "priorQuarterAccessionNumber": null,    // null for "new", required for "add"
  "currentQuarterAccessionNumber": "0001193125-26-054580",

  "sourceURL": "https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml",
  "filedAt": "2026-02-17"
}
```

**Row-level invariants** (parser/loader enforced; contract tests assert on every fixture):
- `clusterEventType="new"` ↔ `priorPctOfBook IS NULL` ↔ `priorQuarterAccessionNumber IS NULL`.
- `clusterEventType="add"` ↔ both prior fields are populated.
- `pctOfBookDelta === currentPctOfBook - (priorPctOfBook ?? 0)`.
- Envelope-level: `clusterSignal.strength === sum(rows[i].pctOfBookDelta)` modulo floating-point at the 6th decimal.

### Q6 `query_full_ticker_delta_picture`
**Input:** `{ ticker: string, quarter?: string, limit?: number /* default 500, applied per bucket */ }`
**Envelope `rows`:** four buckets in one object:
```jsonc
{
  "ticker": "AAPL",
  "issuerName": "APPLE INC",
  "cusip": "037833100",
  "currentQuarter": "2025-12-31",
  "priorQuarter": "2025-09-30",
  "newInitiations": [ /* Q1 rows */ ],
  "exits":          [ /* Q2 rows */ ],
  "materialAdds":   [ /* Q3 rows, deltaType="add" */ ],
  "materialTrims":  [ /* Q3 rows, deltaType="trim" */ ]
}
```

### E1 `get_filer_delta`
**Input:** `{ filerCIK: string /* 10-digit padded */, currentQuarter?: string, priorQuarter?: string, limit?: number /* default 1000 per sub-array */ }`
**Output:** Q4-shape (no fuzzy resolution).
**`_meta.pricing.executeUsd: "0.001"`**, `latencyClass: "instant"`, `surface: "both"`, `queryEligible: true`.

### E2 `get_ticker_delta`
**Input:** `{ ticker: string, quarter?: string, minPctOfBookFilter?: number, limit?: number /* default 500 per bucket */ }`
**Output:** Q6-shape.
**`_meta.pricing.executeUsd: "0.001"`**, `latencyClass: "instant"`, `surface: "both"`, `queryEligible: true`.

### E3 `list_superinvestors`
**Input:** `{ tier?: "legendary" | "well-known" | "notable", strategy?: string }`
**Output `rows[]`:**
```jsonc
{
  "filerCIK": "0001067983",
  "displayName": "Berkshire Hathaway",
  "edgarName": "BERKSHIRE HATHAWAY INC",
  "aliases": ["Buffett", "Warren Buffett", "Berkshire"],
  "superinvestorTier": "legendary",
  "primaryStrategy": "value",
  "lastFilingPeriodOfReport": "2025-12-31",
  "lastFilingAccessionNumber": "0001193125-26-054580"
}
```
**`_meta.pricing.executeUsd: "0.0001"`** (very cheap discovery method; ~1/10 of intelligence call).

### E4 `list_quarters_available`
**Input:** `{ filerCIK?: string }`
**Output `rows[]`:**
```jsonc
{
  "periodOfReport": "2025-12-31",
  "filersIngestedCount": 4823,
  "isCurrentSeason": false,
  "seasonStatus": "complete",
  "earliestFiledAt": "2026-01-15",
  "latestFiledAt": "2026-02-17"
}
```
**`_meta.pricing.executeUsd: "0.0001"`**.

### E5 `get_filing`
**Input:** `{ accessionNumber: string }`
**Output:**
```jsonc
{
  "accessionNumber": "0001193125-26-054580",
  "filerCIK": "0001067983",
  "filerName": "BERKSHIRE HATHAWAY INC",
  "form": "13F-HR",
  "isAmendment": false,
  "supersededByAccession": null,
  "periodOfReport": "2025-12-31",
  "filedAt": "2026-02-17",
  "bookValueUSD": 274160086701,
  "valueScale": "USD",
  "tableEntryTotal": 110,
  "primaryDocURL": "https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/primary_doc.xml",
  "infoTableURL": "https://www.sec.gov/Archives/edgar/data/1067983/000119312526054580/50240.xml",
  "holdings": [
    {
      "ticker": "F",                     // null if CUSIP unresolved
      "issuerName": "ALLY FINL INC",
      "cusip": "02005N100",
      "valueUSD": 894556758,
      "shares": 19751750,
      "sshPrnamtType": "SH",
      "putCall": null,
      "pctOfBook": 0.0033,
      "convictionTier": "scout"
    }
  ]
}
```
**`_meta.pricing.executeUsd: "0.001"`**.

## 9. Deterministic rules (computed at ingestion, not at request time)

### Conviction tiering
```
core        if pctOfBook >= 0.05
meaningful  if 0.01 <= pctOfBook < 0.05
starter     if 0.0025 <= pctOfBook < 0.01
scout       if pctOfBook < 0.0025
```
Boundary tests: exactly `0.01` → `meaningful`. Exactly `0.05` → `core`.

### Delta classification (after `(cusip, putCall)` aggregation per filing)
```
new       if cusip in current AND not in prior
exit      if cusip in prior AND not in current
add       if currentShares > priorShares * 1.25
trim      if currentShares < priorShares * 0.75
unchanged otherwise
```
Boundary tests: `currentShares == priorShares * 1.25` → `unchanged` (strict `>`); same for trim.

### Cluster detection
For ticker `T` and current quarter `Q`:
1. Find every superinvestor (E3) whose Q-filing has a `new` or `add` event on `T`.
2. `memberCount = |{filers}|`. If `memberCount < 3` → no cluster.
3. `tier = weak (3-4) | notable (5-7) | strong (>=8)`.
4. `strength = sum_over_members(pctOfBookDelta)` where `pctOfBookDelta = currentPctOfBook - (priorPctOfBook ?? 0)` (`priorPctOfBook` is `null` for `new`, treated as 0 for the sum).
5. **Envelope-level invariant (calibration 7):** `clusterSignal.strength === sum(rows[i].pctOfBookDelta)`. Computed off the same domain layer; asserted in the Q5 contract tests.

## 10. Five reviewer-named capabilities — implementation map

| Capability | Where it lives | How V1 ships it |
|------------|----------------|------------------|
| Delta classification | `/src/domain/delta.ts` (pure) | Deterministic rules above; computed at ingest, cached in `holdings_delta`. Boundary unit tests for ±25% and zero-share edges. |
| Conviction tiering | `/src/domain/conviction.ts` (pure) | Deterministic rules above; computed at ingest. Boundary unit tests at 0.0025 / 0.01 / 0.05. |
| Fuzzy filer name resolution | `/src/resolution/filer.ts` | Levenshtein + token overlap + `superinvestors.json` aliases; tests for "Burry"→1649339, "Buffett"→1067983, "Ackman"→1336528, ambiguous "Capital" → top 3. Below-threshold returns `ambiguous_filer` error. |
| Amendment handling | Ingestion pipeline + `filings.supersededByAccession` | 13F-HR/A flips `coverPage.isAmendment=true`; we mark prior accession superseded, recompute deltas, and surface `meta.restatementApplied: true` in any response materially affected. |
| Cluster detection | `/src/domain/cluster.ts` (pure) | Rules above; runs across `superinvestors.json` after each ingestion run. Tests with synthetic 3-/5-/8-member sets verifying tier and strength math. |

## 11. Why free substitutes are insufficient (per-prompt grounding for the Optimization Skill)

| Free alternative | Where it fails on our must-win prompts |
|------------------|----------------------------------------|
| ChatGPT (web-search enabled) | No per-filer book values; cannot compute pctOfBook; hallucinates accession numbers and CUSIPs; no curated superinvestor roster. |
| Claude.ai with web tools | Can fetch one EDGAR page but cannot aggregate across 5,000 filers in a single turn under the 60s budget. |
| EDGAR full-text search | Returns filings, not deltas. No cross-filer aggregation. No conviction weighting. |
| WhaleWisdom Free tier | Rate-gated, no API, dashboard-only. Premium ($300–500/yr) has the data but no agent integration. |
| Dataroma | ~70 managers (we cover ~150 + ingestion path to all ~5,000). No API. No conviction tiering. |
| Stockzoa / Fintel | Behind paywalls, no agent surface, scraping prohibited. |
| sec-api.io | Has data; charges $499+/mo; requires you to compute deltas/clustering yourself. We pre-compute. |

## 12. Freshness, latency, coverage scope

- **Latency target:** p50 < 1s, p95 < 3s, p99 < 10s on every Query and Execute call. Hard cap 60s (Context runtime kill).
- **Freshness:**
  - **Filing seasons** (Feb / May / Aug / Nov): daily ingestion cron at 03:00 ET.
  - **Off-season:** weekly ingestion cron Sunday 03:00 ET.
  - `meta.freshness.asOf` reflects the most recent ingestion-run completion timestamp.
- **Coverage scope (explicit, declared in `meta.coverageScope`):**
  - **In:** Long US equity holdings disclosed via Form 13F-HR / 13F-HR/A INFOTABLE rows. Includes options on US equities (`putCall` preserved).
  - **Out:** Short positions, 13D/13G beneficial-ownership filings, Form 4 insider transactions, multi-quarter trends >2 quarters back, predictive recommendations, non-US filings, private fund holdings not on Form 13F.
- **Coverage universe at launch:**
  - Last 4 quarters of the curated ~150 superinvestor list (cold-start backfill).
  - Expanding via EDGAR full-text search to all ~5,000 active 13F-eligible filers post-launch.

## 13. Cross-cutting locked concerns (Phase 0 sign-off items)

1. **2023 EDGAR unit regime.** Pre-2023-Q3 13Fs report `value` and `tableValueTotal` in **thousands** of dollars; post-2023 in **dollars**. Parser emits `valueScale: "USD" | "USD_THOUSANDS"` per filing. Even though V1 ships only post-2023 data, both code paths are implemented and unit-tested at the boundary. **Test fixture:** at least one pre-2023 filing in the parser test suite to verify the `USD_THOUSANDS` branch.
2. **Filer-named INFOTABLE XML.** Filename is filer-chosen (Berkshire's most recent: `50240.xml`, not `infotable.xml`). Discovery is via `GET /Archives/edgar/data/{CIK}/{accession}/index.json` → pick the `directory.item[]` entry with `.xml` suffix that is **not** `primary_doc.xml`. Never string-construct.
3. **Multi-row-per-CUSIP aggregation.** A single 13F can contain multiple `<infoTable>` rows for the same `(cusip, putCall)` (e.g. Berkshire's 3 rows for ALLY FINL `02005N100` attributed to different `<otherManager>` codes). Aggregation is by `(cusip, putCall)` — sum `sshPrnamt`, sum `value` — **before** any delta math or pctOfBook computation. Class A vs Class B (different CUSIPs) **must NOT** aggregate. Unit tests:
   - Real Berkshire ALLY FINL aggregation (3 rows → 1 logical holding).
   - Synthetic BRK-A vs BRK-B (CUSIP 084670108 vs 084670702) staying separate.
4. **Cadence.** Daily during filing seasons (Feb / May / Aug / Nov), weekly off-season. Confirmed.
5. **Surface enum.** `_meta.surface: "both"` everywhere we want both surfaces. The Context docs are inconsistent ("answer" vs "query") on what to call the Query surface in metadata — the runtime accepts `"both"` per the example servers, and we follow the example servers. A code comment near the metadata definition will note this.
6. **EDGAR User-Agent / SEC blocking WebFetch.** SEC blocks the `WebFetch` content-extraction tool (403). Ingestion uses Node's native `fetch` with a `User-Agent: "Helm13F <name> <email>"` header on every request. All EDGAR HTTP calls route through one rate-limited client (`/src/sources/edgar/client.ts`); no library that could strip headers.

## 14. Optimization target (upgraded from grant-floor to marketing-tier)

**Grant floor (Optimization Skill PASS):** ≥85% pass rate AND ≥5 high-differentiation prompts.

**Helm13F target (lock):** **≥95% pass rate AND ≥7 high-differentiation prompts** with `signoff.overallStatus = "PASS"`. This is the bar that earns the conditional Tier S marketing-support upside per the grant approval ("unambiguously beats free chat, ship it cleanly").

The candidate prompt pool in §6 is designed against this target from Phase 1, not retrofitted in Phase 6. The Optimization Skill's iterative loop (≤5 iterations) tunes schema/description text against the ≥95%/≥7 bar.

**Phase 6 wallet-drawdown watchpoint (runbook).** The Optimization Skill makes real, billed query calls and is wallet-funded. After the first 10–20 validation calls during the Skill run we instrument a wallet-balance check; if E3/E4 discovery calls or any other method are drawing more than the back-of-envelope estimate (≥30% of starting balance), pause and surface the drawdown to the operator before continuing. This is a runbook concern, recorded in `docs/OPTIMIZATION_ARTIFACT.json` under `notes.walletWatchpoint`, not a code change in the server itself.

## 15. EDGAR endpoint catalog (Builder Template Phase 1 — endpoint discovery)

All EDGAR endpoints below verified in Phase 0 against Berkshire CIK `1067983`, accession `0001193125-26-054580`.

### 15.1 Endpoint table

| Category | Endpoint | Purpose | Auth | Rate limit |
|----------|----------|---------|------|------------|
| Submissions metadata | `GET https://data.sec.gov/submissions/CIK{paddedCIK}.json` | All filings for a filer; identifies 13F-HR and 13F-HR/A by `form`. Includes `filings.recent.{accessionNumber, form, filingDate, primaryDocument, periodOfReport}` parallel arrays. Pagination: `filings.files[]` for older history. | None (User-Agent required) | 10 req/s shared |
| Submissions paginated | `GET https://data.sec.gov/submissions/{olderFile}` | Older history pages referenced by `filings.files[].name`. | None (UA required) | 10 req/s shared |
| Filing index | `GET https://www.sec.gov/Archives/edgar/data/{CIK}/{accessionNoDashes}/index.json` | Lists files in a filing directory. Used to discover the filer-named INFOTABLE XML. Returns `directory.item[].name`. | None (UA required) | 10 req/s shared |
| Cover page (always) | `GET https://www.sec.gov/Archives/edgar/data/{CIK}/{accessionNoDashes}/primary_doc.xml` | 13F-HR cover page: `submissionType`, `periodOfReport`, `filingManager.name`, `coverPage.isAmendment`, `summaryPage.tableEntryTotal`, `summaryPage.tableValueTotal` (book value). | None (UA required) | 10 req/s shared |
| Information Table (filer-named) | `GET https://www.sec.gov/Archives/edgar/data/{CIK}/{accessionNoDashes}/{filerNamedFile}.xml` | The actual holdings rows: `infoTable[]` with `nameOfIssuer, titleOfClass, cusip, value, shrsOrPrnAmt.{sshPrnamt, sshPrnamtType}, investmentDiscretion, otherManager, votingAuthority.{Sole, Shared, None}, putCall?`. | None (UA required) | 10 req/s shared |
| Issuer ticker map | `GET https://www.sec.gov/files/company_tickers.json` | Issuer-side ticker → CIK; **not** a CUSIP→ticker map. Useful for input ticker resolution. Schema: `{ "0": { cik_str, ticker, title }, ... }`. | None (UA required) | 10 req/s shared |
| Full-text search | `GET https://efts.sec.gov/LATEST/search-index?q=...&forms=13F-HR` | Discovers filers we haven't seen yet (the long tail beyond the curated 150). Used during universe expansion. | None | (separate host, but conservatively use 10 req/s) |
| CUSIP→ticker (secondary) | `POST https://api.openfigi.com/v3/mapping` | CUSIP→ticker for issuers not in `company_tickers.json` (depositary receipts, etc.). API key required. Cached locally. | API key | 25/min unauth, 250/min with key |

### 15.2 Data hierarchy map

```
SEC EDGAR universe
└── Filer (CIK)
    ├── company_tickers.json (issuer-side; only for filers who are also public issuers)
    ├── submissions/CIK{padded}.json
    │   └── filings.recent[]                      (parallel arrays)
    │       └── { accessionNumber, form, filingDate, primaryDocument, periodOfReport }
    │           └── if form ∈ {13F-HR, 13F-HR/A}:
    │               └── Archives/edgar/data/{CIK}/{accNoDashes}/index.json
    │                   ├── primary_doc.xml          (cover page; periodOfReport, isAmendment, bookValue)
    │                   └── {filerNamed}.xml         (INFOTABLE)
    │                       └── infoTable[]
    │                           └── { nameOfIssuer, titleOfClass, cusip, value,
    │                                  shrsOrPrnAmt.{sshPrnamt, sshPrnamtType},
    │                                  investmentDiscretion, otherManager,
    │                                  votingAuthority.{Sole,Shared,None}, putCall? }
    │                               └── (CUSIP) ─────► OpenFIGI mapping ─► ticker
    │                                                        ↑
    │                                                  cusip_ticker_map (Postgres cache)
    └── (full-text search) efts.sec.gov ──► discovers more CIKs
```

### 15.3 Cross-platform composability check

| Other platform | Shared entity | Correlation identifier | Composability example |
|----------------|---------------|------------------------|------------------------|
| Polymarket / Coinglass tools on Context | None directly (different asset class) | — | — |
| Issuer fundamentals tools (e.g. SEC XBRL, future EDGAR-financials MCP) | Issuer | CIK (issuer-side) and ticker | Helm13F gives "who's buying $TICKER"; an XBRL tool gives "what does $TICKER's balance sheet look like" — agent composes "Buffett bought POOL in Q4 — show me POOL's fundamentals." |
| Hyperliquid / on-chain wallet tools | None | — | — |
| Future earnings / news MCPs | Issuer | ticker | "Did the cluster buy come before or after Q3 earnings?" |

We expose `ticker` and `cusip` as first-class fields on every row to enable downstream agent composition.

### 15.4 Discovery layer audit (per Builder Template sub-step 2.5)

| Required enumeration | Tool exposing it | Pattern |
|----------------------|------------------|---------|
| Curated superinvestor universe | `list_superinvestors` (E3) | List-all, with optional `tier` / `strategy` filter (browse-by). |
| Time axis (which quarters we have) | `list_quarters_available` (E4) | List-all, with optional `filerCIK` filter (browse-by). |
| Filer-level full holdings | `get_filing` (E5) | Browse-by accession (the canonical primary key). |
| Filer-level delta | `get_filer_delta` (E1) | Browse-by CIK, with optional quarter pair. |
| Ticker-level delta | `get_ticker_delta` (E2) | Browse-by ticker, with optional quarter. |

No "trending only" gaps. Every enumeration the agent might need is exposed.

## 16. Pricing (review-phase initial values)

Per the grant instructions for review phase:

- **Listing response price (Query):** `$0.00` during review.
- **Execute pricing:**
  - Intelligence methods (E1, E2): `_meta.pricing.executeUsd: "0.001"`.
  - Discovery methods (E3, E4): `_meta.pricing.executeUsd: "0.0001"` (1/10 of intelligence — these are cheap roster/quarter lookups).
  - Raw filing fetch (E5): `_meta.pricing.executeUsd: "0.001"`.

Post-review price bumps documented in Phase 7 follow-up checklist.

## 17. Out-of-scope (explicit refusals)

These are **rejected** by Helm13F with a structured `not_in_scope` error, never silently approximated:

- Short positions, 13D/G holdings, Form 4 insider transactions.
- Multi-quarter trend analysis (>2 quarters back). V1 supports exactly one `currentQuarter` and one `priorQuarter`.
- Predictive recommendations ("should I buy?", "what will Buffett do next?").
- Non-US equity holdings.
- Private fund / non-13F-disclosed holdings.
- Real-time intra-quarter signal — 13Fs are filed up to 45 days after quarter-end; that latency is intrinsic.

## 18. Acceptance criteria (Phase 7 grant submission gate)

Helm13F is ready for `grants@ctxprotocol.com` review when **all** of:

- [ ] All 6 Query tools + 5 Execute methods registered on Context with `outputSchema` validating against actual `structuredContent`.
- [ ] `createContextMiddleware()` mounted on `/mcp`.
- [ ] Last-4-quarters backfill complete for the curated ~150 superinvestor list.
- [ ] All 5 reviewer-named capabilities ship with passing tests.
- [ ] Ingestion cron deployed and verified to refresh on schedule.
- [ ] `docs/OPTIMIZATION_ARTIFACT.json` shows `signoff.overallStatus = "PASS"` with `passRate ≥ 0.95` AND `highDifferentiationCount ≥ 7`.
- [ ] Listing description on the Context developer dashboard auto-pushed by the Optimization Skill, includes Features / Try Asking (≥7 questions) / Agent Tips per the MCP Server Analysis Prompt (≤5000 chars, no em-dashes, no markdown bold).
- [ ] 30-day uptime monitoring in place (for the second $500 grant payment).
