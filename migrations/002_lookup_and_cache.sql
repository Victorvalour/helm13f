-- Helm13F migration 002 — lookup caches + delta cache + ingestion log
-- See docs/SCHEMAS.md for the human-readable mapping.

BEGIN;

-- 4. cusip_ticker_map — local cache mapping CUSIP → ticker.
--    Sourced from company_tickers.json + OpenFIGI (when CUSIP not in issuer-side map).
--    The `source` column lets us re-verify entries asymmetrically.
CREATE TABLE IF NOT EXISTS cusip_ticker_map (
    cusip               CHAR(9)       PRIMARY KEY,
    ticker              VARCHAR(16),                  -- nullable: explicit "no mapping known"
    issuer_name         TEXT,
    source              TEXT          NOT NULL CHECK (source IN ('company_tickers','openfigi','manual_override')),
    last_verified_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    notes               TEXT
);

CREATE INDEX IF NOT EXISTS cusip_ticker_map_ticker_idx ON cusip_ticker_map (ticker) WHERE ticker IS NOT NULL;

-- 5. delta_cache — pre-computed delta_cache rows keyed by (axis + quarter pair).
--    `key` examples:
--       "filer:0001067983|2025-12-31|2025-09-30"
--       "ticker:AAPL|2025-12-31|2025-09-30"
--       "ticker:AAPL|2025-12-31|2025-09-30|min:0.0025"
--    `payload` is the full structuredContent envelope for the response.
--    `inputs_fingerprint` lets us version-bust safely when the schema changes.
CREATE TABLE IF NOT EXISTS delta_cache (
    cache_key            TEXT          PRIMARY KEY,
    payload              JSONB         NOT NULL,
    inputs_fingerprint   TEXT          NOT NULL,
    schema_version       INTEGER       NOT NULL DEFAULT 1,
    computed_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    expires_at           TIMESTAMPTZ                                -- nullable: cache may be evergreen until next ingest
);

CREATE INDEX IF NOT EXISTS delta_cache_expires_idx       ON delta_cache (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS delta_cache_schema_version_idx ON delta_cache (schema_version);

-- 6. ingestion_log — one row per ingestion run; observability only.
CREATE TABLE IF NOT EXISTS ingestion_log (
    id                       BIGSERIAL    PRIMARY KEY,
    run_kind                 TEXT         NOT NULL CHECK (run_kind IN ('backfill','daily','weekly','manual','amendment_recompute')),
    started_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at             TIMESTAMPTZ,
    duration_ms              INTEGER,
    filings_discovered       INTEGER      NOT NULL DEFAULT 0,
    filings_parsed           INTEGER      NOT NULL DEFAULT 0,
    filings_amended          INTEGER      NOT NULL DEFAULT 0,
    holdings_upserted        INTEGER      NOT NULL DEFAULT 0,
    parse_errors             INTEGER      NOT NULL DEFAULT 0,
    parse_error_samples      JSONB        NOT NULL DEFAULT '[]'::jsonb,
    notes                    TEXT
);

CREATE INDEX IF NOT EXISTS ingestion_log_started_idx ON ingestion_log (started_at DESC);
CREATE INDEX IF NOT EXISTS ingestion_log_kind_idx    ON ingestion_log (run_kind, started_at DESC);

COMMIT;
