-- 005 — Normalize share-class tickers from "HEI/A" to "HEI-A".
--
-- OpenFIGI / EDGAR return share-class tickers using "/" as the separator
-- (HEI/A, LEN/B). The server output schema enforces "^[A-Z0-9.\-]{1,16}$"
-- which rejects "/". This was caught by Context's smoke test on the
-- get_filing tool:
--   data/holdings/30/ticker must match pattern "^[A-Z0-9.\-]{1,16}$"
--
-- Going forward, the CusipResolver normalizes ticker on read AND write.
-- This migration fixes existing rows in both `holdings` and
-- `cusip_ticker_map` for the data ingested before the resolver fix.

BEGIN;

UPDATE holdings
   SET ticker = REPLACE(ticker, '/', '-')
 WHERE ticker LIKE '%/%';

UPDATE cusip_ticker_map
   SET ticker = REPLACE(ticker, '/', '-')
 WHERE ticker LIKE '%/%';

COMMIT;
