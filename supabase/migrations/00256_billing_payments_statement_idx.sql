-- Performance: index billing_payments.billing_statement_id
--
-- The FK was created without an index in migration 00075. Postgres does not
-- auto-index FKs, so `WHERE billing_statement_id IN (...)` was doing a
-- sequential scan every time — felt as slow Tally Inbox load times.
--
-- This index is essential for:
--   - The Tally Inbox API (lists payments per open statement)
--   - The /accounting/receivables paid-to-date roll-up
--   - The payment-reminder cron that joins payments to compute outstanding
--
-- CONCURRENTLY would be ideal in prod but Supabase's migration runner wraps
-- each file in a transaction and doesn't allow CONCURRENTLY there. The table
-- is small enough (one row per payment, expected <10K rows) that a brief
-- exclusive lock during index build is fine.

CREATE INDEX IF NOT EXISTS idx_billing_payments_statement_id
  ON billing_payments (billing_statement_id);
