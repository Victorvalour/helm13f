-- Helm13F migration 001 — filers, filings, holdings
-- Phase 2 design. See docs/SCHEMAS.md for human-readable mapping.
-- Naming: column names are snake_case at the SQL layer; the JSON Schemas
-- expose camelCase. Mapping is done in /src/db.

BEGIN;

-- 1. filers — every CIK we have ever seen file a 13F-HR.
--    `is_superinvestor` and `superinvestor_tier` MUST be paired:
--    is_superinvestor=false  ↔  superinvestor_tier IS NULL.
CREATE TABLE IF NOT EXISTS filers (
    filer_cik           CHAR(10)        PRIMARY KEY,
    filer_name          TEXT            NOT NULL,
    normalized_name     TEXT            NOT NULL,
    display_name        TEXT,
    is_superinvestor    BOOLEAN         NOT NULL DEFAULT FALSE,
    superinvestor_tier  TEXT            CHECK (superinvestor_tier IN ('legendary','well-known','notable')),
    primary_strategy    TEXT,
    aliases             JSONB           NOT NULL DEFAULT '[]'::jsonb,
    last_seen_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    -- Pairing invariant. Enforced at write time too; this is the safety net.
    CONSTRAINT filers_superinvestor_tier_pairing CHECK (
        (is_superinvestor = FALSE AND superinvestor_tier IS NULL)
        OR
        (is_superinvestor = TRUE  AND superinvestor_tier IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS filers_normalized_name_idx ON filers (normalized_name);
CREATE INDEX IF NOT EXISTS filers_aliases_gin_idx     ON filers USING GIN (aliases jsonb_path_ops);
CREATE INDEX IF NOT EXISTS filers_superinvestors_idx  ON filers (is_superinvestor) WHERE is_superinvestor = TRUE;

-- 2. filings — one row per accession of form ∈ {13F-HR, 13F-HR/A}.
--    book_value_usd is normalised to dollars regardless of value_scale.
--    superseded_by_accession is set when an amendment (13F-HR/A) replaces this row.
CREATE TABLE IF NOT EXISTS filings (
    accession_number          VARCHAR(20)  PRIMARY KEY,
    filer_cik                 CHAR(10)     NOT NULL REFERENCES filers(filer_cik),
    form                      VARCHAR(16)  NOT NULL CHECK (form IN ('13F-HR','13F-HR/A')),
    is_amendment              BOOLEAN      NOT NULL DEFAULT FALSE,
    superseded_by_accession   VARCHAR(20)  REFERENCES filings(accession_number) DEFERRABLE INITIALLY DEFERRED,
    period_of_report          DATE         NOT NULL,
    filing_date               DATE         NOT NULL,
    book_value_usd            BIGINT       NOT NULL CHECK (book_value_usd >= 0),
    value_scale               TEXT         NOT NULL CHECK (value_scale IN ('USD','USD_THOUSANDS')),
    table_entry_total         INTEGER      NOT NULL CHECK (table_entry_total >= 0),
    primary_doc_url           TEXT         NOT NULL,
    info_table_url            TEXT         NOT NULL,
    info_table_filename       TEXT         NOT NULL,  -- e.g. "50240.xml" — discovered via index.json
    raw_xml_sha256            CHAR(64),               -- audit trail; nullable until ingestion writes it
    ingested_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (filer_cik, period_of_report, form)
);

CREATE INDEX IF NOT EXISTS filings_filer_period_idx       ON filings (filer_cik, period_of_report DESC);
CREATE INDEX IF NOT EXISTS filings_period_idx             ON filings (period_of_report DESC);
CREATE INDEX IF NOT EXISTS filings_amendments_idx         ON filings (is_amendment) WHERE is_amendment = TRUE;
CREATE INDEX IF NOT EXISTS filings_active_idx             ON filings (filer_cik, period_of_report) WHERE superseded_by_accession IS NULL;

-- 3. holdings — one row per (accession, cusip, putCall) AFTER multi-row aggregation.
--    The parser MUST aggregate raw <infoTable> rows by (cusip, putCall) before writing.
--    pct_of_book is precomputed at ingest: shares-or-value-based (see /src/domain/conviction.ts).
--    pct_of_book is a fraction in [0, 1] with up to 4 decimal places.
--    conviction_tier is precomputed at ingest from pct_of_book.
CREATE TABLE IF NOT EXISTS holdings (
    accession_number     VARCHAR(20)   NOT NULL REFERENCES filings(accession_number) ON DELETE CASCADE,
    filer_cik            CHAR(10)      NOT NULL,
    period_of_report     DATE          NOT NULL,
    cusip                CHAR(9)       NOT NULL,
    ticker               VARCHAR(16),                    -- nullable until CUSIP resolves
    issuer_name          TEXT          NOT NULL,
    title_of_class       TEXT          NOT NULL,
    shares               BIGINT        NOT NULL CHECK (shares >= 0),
    value_usd            BIGINT        NOT NULL CHECK (value_usd >= 0),
    pct_of_book          NUMERIC(8,6)  NOT NULL CHECK (pct_of_book >= 0 AND pct_of_book <= 1),
    conviction_tier      TEXT          NOT NULL CHECK (conviction_tier IN ('core','meaningful','starter','scout')),
    ssh_prnamt_type      VARCHAR(8)    NOT NULL CHECK (ssh_prnamt_type IN ('SH','PRN')),
    put_call             VARCHAR(8)    CHECK (put_call IS NULL OR put_call IN ('Put','Call')),
    investment_discretion VARCHAR(16),
    voting_sole          BIGINT        NOT NULL DEFAULT 0,
    voting_shared        BIGINT        NOT NULL DEFAULT 0,
    voting_none          BIGINT        NOT NULL DEFAULT 0,
    -- After (cusip, putCall) aggregation per filing, this is the natural key:
    PRIMARY KEY (accession_number, cusip, put_call)
);

-- Per the contract, these are the lookups that drive every Query tool:
CREATE INDEX IF NOT EXISTS holdings_ticker_period_idx  ON holdings (ticker, period_of_report) WHERE ticker IS NOT NULL;
CREATE INDEX IF NOT EXISTS holdings_filer_period_idx   ON holdings (filer_cik, period_of_report);
CREATE INDEX IF NOT EXISTS holdings_cusip_idx          ON holdings (cusip);
CREATE INDEX IF NOT EXISTS holdings_period_cusip_idx   ON holdings (period_of_report, cusip);
-- For Q1/Q2 cluster scans of superinvestor-only holdings on a ticker:
CREATE INDEX IF NOT EXISTS holdings_pct_of_book_idx    ON holdings (period_of_report, pct_of_book DESC);

COMMIT;
