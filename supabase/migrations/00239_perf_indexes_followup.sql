-- Follow-up to 00237_perf_indexes.sql.
--
-- 00237 used CREATE INDEX CONCURRENTLY, which `supabase db push` cannot run
-- (it pipelines statements; CONCURRENTLY may not run inside a pipeline/transaction).
-- 00237 was marked `applied` in the migration history to unblock 00238, but three
-- of its four indexes were never actually created on production. This migration
-- creates them with a plain CREATE INDEX (these tables are tiny — leads ~1.7k rows,
-- bookings <100, service_usage_records 0 — so the build is sub-second and the brief
-- lock is negligible; CONCURRENTLY bought nothing at this scale).
--
-- idx_usage_charges_contract_status_date (00237 #1) already exists on prod — omitted.
--
-- CORRECTION: 00237 #2 indexed service_usage_records(used_at), but that column does
-- not exist — the index could never have been created. The billing rollup actually
-- filters service_usage_records by contract_id + period_year + period_month
-- (src/lib/billing.ts:254, :1107), so the correct index covers those columns.

-- 00237 #2 (corrected) — service_usage_records billing-rollup filter.
CREATE INDEX IF NOT EXISTS idx_service_usage_records_contract_period
  ON service_usage_records (contract_id, period_year, period_month);

-- 00237 #3 — leads(location_id, created_at): dashboard + daily digest filters.
CREATE INDEX IF NOT EXISTS idx_leads_location_created_at
  ON leads (location_id, created_at DESC);

-- 00237 #4 — bookings(location_id, booking_date, status): daily digest per-location.
CREATE INDEX IF NOT EXISTS idx_bookings_location_date_status
  ON bookings (location_id, booking_date DESC, status);
