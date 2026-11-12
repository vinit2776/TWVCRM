-- Performance indexes for hot query paths
-- These were identified as missing during a site performance audit.
--
-- NOTE: originally written with CREATE INDEX CONCURRENTLY, which Supabase's
-- migration runner cannot execute (it pipelines statements; CONCURRENTLY can't
-- run inside a pipeline). On production this migration only got as far as
-- building index #1 as INVALID before erroring, and was manually marked
-- `applied` to unblock later migrations — see 00239_perf_indexes_followup.sql
-- (which recreates #2-#4 with corrections, #2's column name was also wrong)
-- and 00240_rebuild_invalid_usage_charges_index.sql (which rebuilds #1 clean).
-- Switched to plain CREATE INDEX here so a from-scratch migration run doesn't
-- hard-abort at this file; every table below is empty on a fresh database, so
-- the brief lock plain CREATE INDEX takes costs nothing there. IF NOT EXISTS
-- in the two follow-up files makes them safe no-ops if this file already
-- created the same index.

-- 1. usage_charges(contract_id, status, charge_date)
--    Billing generation queries usage_charges by contract_id + status='pending' + date range.
--    Separate single-column indexes exist but Postgres can only use one per scan.
--    A composite covering all three columns (with a partial WHERE) gives index-only scans.
CREATE INDEX IF NOT EXISTS idx_usage_charges_contract_status_date
  ON usage_charges (contract_id, status, charge_date DESC)
  WHERE status = 'pending';

-- 2. service_usage_records(used_at) — REMOVED.
--    service_usage_records has no `used_at` column (never did — see
--    00119_service_quotas.sql), so this statement could never succeed. On
--    production it was never reached (the file errored earlier, at #1's
--    CONCURRENTLY-in-pipeline issue). 00239_perf_indexes_followup.sql creates
--    the actually-correct index for this table's real billing-rollup filter.

-- 3. leads(location_id, created_at)
--    Dashboard and daily digest both filter leads by location_id AND created_at range.
--    Composite index covers both columns in one scan.
CREATE INDEX IF NOT EXISTS idx_leads_location_created_at
  ON leads (location_id, created_at DESC);

-- 4. bookings(location_id, booking_date, status)
--    Daily digest queries bookings per location filtered by booking_date.
--    Composite index covers the three columns used together in filter+order.
CREATE INDEX IF NOT EXISTS idx_bookings_location_date_status
  ON bookings (location_id, booking_date DESC, status);
