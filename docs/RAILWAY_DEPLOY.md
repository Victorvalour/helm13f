# Railway deployment — operator runbook

Phase 4 of the Helm13F build. End state: public HTTPS endpoint serving
`/mcp` + `/health`, with daily/weekly ingestion running on the same image
as a separate scheduled service. All gated behind Context's
`createContextMiddleware()`.

## Prerequisites

- A Railway account (https://railway.com) — free tier is sufficient for
  the review phase.
- Railway CLI installed locally:
  ```
  npm i -g @railway/cli
  railway login
  ```
- The Helm13F repo connected to a GitHub remote so Railway can build on
  push. (Local commits are in place; push once GitHub auth is sorted —
  see `STATE.md`.)
- Real values for the two operator-provided env vars:
  - `EDGAR_USER_AGENT` — `"Helm13F <your-name> <your-email>"` per SEC
    policy. Use the real email tied to operator's GitHub commit history.
  - `OPENFIGI_API_KEY` — optional; boosts CUSIP→ticker resolution rate
    from 25 req/min to 250 req/min. Generate at
    https://www.openfigi.com/api.

## Step 1 — create the Railway project

```
railway init                       # in the helm13f repo root
# Pick: "Empty Project"
# Project name: helm13f
```

This creates a Railway project with no services yet.

## Step 2 — add Postgres + Redis databases

The Railway CLI's `add` flags have changed over time. Either path works:

**CLI path (current syntax):**
```
railway add --database postgres
railway add --database redis
```
If `--database` is also rejected, run `railway add` with no flags — the
CLI drops into an interactive picker. Select "Database" → Postgres, then
re-run for Redis.

**Dashboard path (easiest):**
1. Open https://railway.com/project/<your-project-id>
2. Click **+ Create** → **Database** → **Add Postgres**
3. Click **+ Create** → **Database** → **Add Redis**

Either way, Railway provisions both addons and injects `DATABASE_URL` +
`REDIS_URL` as automatic environment variables for every service in the
project. **You do not set these by hand.**

Verify in the dashboard that both plugins show "Active" / green before
deploying any service.

## Step 3 — deploy the MCP web service

**CLI path:**
```
railway up                         # builds the Dockerfile, deploys
```

Railway reads `railway.json` and picks up:
- `build.dockerfilePath: "Dockerfile"`
- `deploy.startCommand: "pnpm start"` (the HTTP server)
- `deploy.healthcheckPath: "/health"`

**Dashboard path:**
1. From the project page → **+ Create** → **Empty Service**.
2. Settings → **Source** → connect this GitHub repo (or **Empty** if
   pushing via `railway up`).
3. Settings → **Build** → confirm "Dockerfile" is detected.
4. Click **Deploy**.

The first build takes 3-5 min. Subsequent builds are cached.

**Set the operator-supplied env vars** (DATABASE_URL + REDIS_URL are
already injected by the plugins; do NOT override):

**CLI path:**
```
railway variables --set EDGAR_USER_AGENT="Helm13F <Real-Name> <real-email@domain.com>"
railway variables --set OPENFIGI_API_KEY=<key>           # optional
railway variables --set LOG_LEVEL=info
railway variables --set INGESTION_MODE=cron
railway variables --set CONTEXT_MIDDLEWARE_ENABLED=false # KEEP FALSE during smoke tests; flip to true before Phase 5
```

Some CLI versions use `railway variables set KEY=value` (no `--set`).
If the first form fails, try without the dashes.

**Dashboard path:** open the service → **Variables** tab → **+ New
Variable** for each row above. Click **Deploy** after the last one to
trigger a redeploy with the new env.

After setting variables, redeploy so they take effect:

```
railway up
```

## Step 4 — run migrations against the deployed Postgres

Migrations live in `/migrations` and the runner is `pnpm migrate`. The
fastest way is a one-shot `railway run`:

```
railway run pnpm migrate
```

`railway run` exposes the project's env vars (including `DATABASE_URL`
from the Postgres plugin) to a local process, so migrations apply
against the deployed DB without redeploying the image.

Expected output:
```
apply 001_filers_filings_holdings.sql
apply 002_lookup_and_cache.sql
done — applied 2 migration(s)
```

Re-running is idempotent (returns `0 applied`).

## Step 5 — cold-start backfill

Pull the last 4 quarters for the curated superinvestor roster:

```
railway run pnpm backfill -- --quarters=4
```

This typically takes 5-15 minutes (rate-limited by SEC's 10 req/s).
Watch progress in the terminal — at the end you'll see something like:

```
backfill done in 612.4s: {
  ingestionLogId: 1,
  filingsDiscovered: ~560,
  filingsParsed: ~560,
  filingsAmended: ~5,
  holdingsUpserted: ~40,000,
  parseErrors: 0,
}
```

Any non-zero `parseErrors` are surfaced with their accession + error
message in the runbook output — they're not blocking but should be
investigated.

## Step 6 — add the scheduled ingestion service

Create a second Railway service on the same Docker image, with a
different start command:

```
railway service create
# Service name: helm13f-ingest
```

In the Railway dashboard, configure this service:

1. **Source:** point at the same GitHub repo (or use `railway up` from
   this directory, but choose the new service when prompted).
2. **Start command (override):** `pnpm ingest:scheduled`
3. **Cron schedule (Railway → Settings → Cron):**
   - Daily during filing seasons (Feb, May, Aug, Nov):
     `0 8 * 2,5,8,11 *` (08:00 UTC = 03:00 ET, every day in those months).
   - Weekly off-season:
     `0 8 * 1,3,4,6,7,9,10,12 0` (08:00 UTC Sundays only).
   - Or one cron at `0 8 * * *` (daily); the script self-throttles to
     "weekly only on Sundays" outside filing-season months.
4. **Disable HTTP healthcheck** on this service (cron services don't
   serve HTTP).

The same Postgres + Redis + env vars are inherited from the project.

## Step 7 — obtain the public URL

```
railway domain                     # on the MCP web service
```

Railway issues an HTTPS domain like
`helm13f-mcp-production-XXXX.up.railway.app`. **This is your MCP
endpoint URL** for Phase 5 registration.

## Step 8 — smoke-test the deployment

```
URL=https://helm13f-mcp-production-XXXX.up.railway.app

# Health check.
curl -fsS "$URL/health"
# → {"ok":true,"name":"helm13f","version":"0.1.0"}

# MCP initialize + tools/list (no auth needed for these methods).
curl -fsS -X POST "$URL/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}'

# Take the returned mcp-session-id header and use it on tools/list:
SESSION="<paste-mcp-session-id-from-above-response>"
curl -fsS -X POST "$URL/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

The `tools/list` response should return the 6 Query + 5 Execute tool
definitions exactly as published in `src/server/schemas/`.

## Env-var checklist

| Variable | Source | Required | Notes |
|---|---|---|---|
| `DATABASE_URL` | Railway Postgres plugin | yes | Auto-injected. Do not override. |
| `REDIS_URL` | Railway Redis plugin | yes | Auto-injected. Do not override. |
| `EDGAR_USER_AGENT` | operator | yes | SEC mandate: must be real name + email. |
| `OPENFIGI_API_KEY` | operator | no | Boosts rate limit 10× for CUSIP resolution. |
| `CONTEXT_MIDDLEWARE_ENABLED` | operator | yes (`true` once live) | Set after Phase 5 registration. Defaults to `true`. |
| `CONTEXT_API_KEY` | Phase 5 | post-Phase-5 | From ctxprotocol.com/developer. |
| `TOOL_ID` | Phase 5 | post-Phase-5 | Generated at registration. |
| `LOG_LEVEL` | operator | no | `info` recommended. |
| `INGESTION_MODE` | operator | no | `cron` in prod; informational only. |
| `PORT` | Railway | auto | Railway sets this; we default to 8080. |

## Troubleshooting

- **`pnpm migrate` fails with "permission denied for database":** the
  Postgres plugin URL connects as the project user with full schema
  privileges; if you see this, you're hitting a different DB than
  expected. `railway variables get DATABASE_URL` to verify.
- **`/mcp` returns 401 Unauthorized:** `createContextMiddleware()` is
  rejecting your test request because no Context JWT is attached.
  That's expected — Context's marketplace handles the JWT when calls
  arrive via their runtime. For smoke tests, set
  `CONTEXT_MIDDLEWARE_ENABLED=false` temporarily.
- **Cron service never runs:** Railway cron jobs require the service's
  start command + cron schedule both set in the dashboard. Confirm
  under Settings → Triggers.
- **CPU/memory burned during backfill:** SEC's 10 req/s rate limiter
  paces us; expect the backfill to be IO-bound not CPU-bound. If the
  container OOMs, bump Railway's RAM limit to 1 GB.
