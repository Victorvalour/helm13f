-- 004 — Drop the residual NOT NULL on holdings.put_call.
--
-- Migration 003 dropped the PRIMARY KEY (accession_number, cusip, put_call)
-- and added a UNIQUE constraint with NULLS NOT DISTINCT, intending to allow
-- NULL put_call. But Postgres tracks the per-column NOT NULL attribute
-- separately from the PK constraint — dropping the PK does NOT drop the
-- implicit NOT NULL that was added when the PK was originally created.
-- Backfills kept failing with:
--
--   null value in column "put_call" of relation "holdings"
--   violates not-null constraint
--
-- Fix: explicitly drop the NOT NULL attribute. The CHECK constraint
-- (put_call IS NULL OR put_call IN ('Put','Call')) and the new UNIQUE
-- NULLS NOT DISTINCT remain in place.

BEGIN;

ALTER TABLE holdings ALTER COLUMN put_call DROP NOT NULL;

COMMIT;
