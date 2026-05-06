# CLAUDE.md — Helm13F project rules

You are continuing work on Helm13F, an MCP server for the Context Protocol marketplace
(https://ctxprotocol.com), Tier S grant. The build is mid-flight; previous Claude
sessions have already done substantial work.

## Resume protocol (read this FIRST on every new session)

1. Read `STATE.md` (the live project state). Single source of truth.
2. Read `TODO.md` (phase tracker; status of each numbered step).
3. Run `git log --oneline -10` to confirm last commit.
4. **Do NOT re-read every source file.** Trust `STATE.md` + `git log`.
5. **Do NOT re-fetch the Phase 0 docs (Context Protocol, EDGAR, etc.).**
   Their key facts are in `docs/PRODUCT_CONTRACT.md` already.

## Authoritative documents

- `docs/PRODUCT_CONTRACT.md` — surface, schemas, calibrations, optimisation target.
  Re-read only the sections relevant to the current step.
- `docs/SCHEMAS.md` — DB tables ↔ JSON Schemas mapping.
- `STATE.md` — current step, what's done, what's next, blockers.
- `TODO.md` — phase + step tracker.

## Operator workflow (locked)

Full autonomy through Phase 3 steps 2-12, Phase 4 (Railway deploy),
Phase 5 (Context registration). Stop and ask only on:

- Architectural decision contradicting the contract.
- Test failure that cannot be resolved.
- External-service block (SEC rate limits, OpenFIGI account, Railway quirk).
- Discovery that materially changes the build plan.

**Hard-stop checkpoints (require explicit operator approval):**

1. **Pre-Phase-6** — before firing the Optimization Skill. Operator must verify
   deployed tool URL, candidate prompt pool, wallet funding state.
2. **Pre-Phase-7** — before sending the review email to grants@ctxprotocol.com.
   Operator reads + approves the draft.

## Token-economy rules (non-negotiable for this project)

- **Never paste full file contents back to the user.** Use `Read` tool with line
  ranges + Edit tool with diff-only edits.
- **Always pipe gate output through `| tail -5`** unless investigating a failure.
  `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check` all dump
  hundreds of lines — only the last few matter.
- **One commit per numbered substep, not per file.** Smaller commits = cheaper
  resumes via `git log`.
- **Update STATE.md before every commit.** That file is the resume bootstrap.
- **End-of-step summary in chat: one or two sentences max.** No paragraphs.
- **`/compact` between numbered steps**, not when usage is near zero.
- **Don't echo file contents in chat.** If the user asks to see a file, link to
  it: `[file.ts](src/file.ts)` — they can open it in the IDE.

## Calibrations locked from Phase 0

1. `valueScale: USD | USD_THOUSANDS` enum on every parsed filing.
2. Filer-named INFOTABLE XML — discover via `index.json`, never string-construct.
3. Multi-row-per-CUSIP aggregation by `(cusip, putCall)` per filing **before** delta math.
4. Cadence: daily Feb/May/Aug/Nov, weekly off-season.
5. `_meta.surface: "both"` — code comment near metadata definitions documents the docs-inconsistency.
6. EDGAR fetched via Node `fetch` + `User-Agent` header; one rate-limited client.
7. Q5 ClusterEventRow shape; envelope-level invariant `clusterSignal.strength === sum(rows[i].pctOfBookDelta)`.

## Optimization target (locked above grant floor)

PASS = `passRate ≥ 0.95` AND `highDifferentiationCount ≥ 7`.
(Contract floor is 0.85 / 5; we aim higher to earn the conditional Tier S
marketing-support upside.)

## Scripts

```
pnpm test          # vitest run
pnpm lint          # eslint
pnpm typecheck     # tsc --noEmit
pnpm format:check  # prettier --check
pnpm format        # prettier --write
pnpm migrate       # apply SQL migrations against DATABASE_URL
pnpm db:up         # docker-compose Postgres + Redis
pnpm dev           # tsx watch src/server/main.ts
pnpm start         # tsx src/server/main.ts
```

## Dependencies of note

- `@modelcontextprotocol/sdk` ^1.29 — MCP server + transports
- `@ctxprotocol/sdk` ^0.13 — `createContextMiddleware()` (paid-tool gate)
- `pg` ^8.20 — Postgres
- `ioredis` (lands in step 10) — Redis cache
- `fast-xml-parser` ^5.7 — 13F-HR XML
- `ajv` + `ajv-formats` — schema validation in tests
- `vitest` ^1.6 — test runner

## Conventions

- TypeScript strict + `exactOptionalPropertyTypes: true`. When forwarding optional
  args, use conditional spreads `...(x !== undefined ? { x } : {})` not
  `x: x ?? undefined`.
- Repos return camelCase TypeScript shapes; SQL uses snake_case.
- BigInts at the DB boundary; `Number()` only for envelope output (range-safe).
- Error throwing: dedicated `*Error` classes per module (`EdgarHttpError`,
  `InfoTableParseError`, `DbError`, …). Never throw bare `Error`.
- Tests live alongside the module, mirroring source path under `tests/`.

## What NOT to do

- Don't fetch the same EDGAR endpoints again — they're verified in `tests/fixtures/13f/`.
- Don't re-fetch the Phase 0 grant/build docs — facts are codified in
  `docs/PRODUCT_CONTRACT.md`.
- Don't add features beyond the contract scope (no 13D/G, no Form 4, no
  multi-quarter trends, no predictions, no non-US).
- Don't commit secrets. `.env*.local` is gitignored.
- Don't `git push --force` to main; `origin` push is allowed but operator
  configures GitHub auth; pushes blocked are deferred not retried.
