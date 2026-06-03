-- Performance indexes for hot query paths
-- These were identified as missing during a site performance audit.
-- All use CREATE INDEX CONCURRENTLY so they can be applied without locking.

-- 1. usage_charges(contract_id, status, charge_date)
--    Billing generation queries usage_charges by contract_id + status='pending' + date range.
--    Separate single-column indexes exist but Postgres can only use one per scan.
--    A composite covering all three columns (with a partial WHERE) gives index-only scans.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_charges_contract_status_date
  ON usage_charges (contract_id, status, charge_date DESC)
  WHERE status = 'pending';

-- 2. service_usage_records(used_at)
--    Billing rollup queries service_usage_records by used_at date range.
--    No index existed on this column — full table scan on every monthly rollup.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_service_usage_records_used_at
  ON service_usage_records (used_at DESC);

-- 3. leads(location_id, created_at)
--    Dashboard and daily digest both filter leads by location_id AND created_at range.
--    Composite index covers both columns in one scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_location_created_at
  ON leads (location_id, created_at DESC);

-- 4. bookings(location_id, booking_date, status)
--    Daily digest queries bookings per location filtered by booking_date.
--    Composite index covers the three columns used together in filter+order.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_location_date_status
  ON bookings (location_id, booking_date DESC, status);
