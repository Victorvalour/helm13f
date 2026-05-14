-- 003 — Fix holdings.put_call NOT NULL implicit constraint.
--
-- The original schema set PRIMARY KEY (accession_number, cusip, put_call),
-- which implicitly forces put_call NOT NULL. But the parser correctly emits
-- NULL for the vast-majority case of equity holdings without put/call —
-- only options carry 'Put' / 'Call'. Every backfill insert was failing.
--
-- Fix: drop the PK and replace with a UNIQUE constraint using
-- NULLS NOT DISTINCT so NULL put_call rows are still deduplicated per
-- (accession_number, cusip). Requires PostgreSQL 15+ (Railway plugin runs
-- PG 16, verified).

BEGIN;

ALTER TABLE holdings DROP CONSTRAINT holdings_pkey;

ALTER TABLE holdings
    ADD CONSTRAINT holdings_natural_key UNIQUE NULLS NOT DISTINCT
        (accession_number, cusip, put_call);

COMMIT;
