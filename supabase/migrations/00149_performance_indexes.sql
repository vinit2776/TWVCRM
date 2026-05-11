-- Performance indexes — Phase 1
--
-- These indexes address the two heaviest query patterns identified
-- in the audit: payment balance checks and booking quota calculations.
-- Note: CONCURRENTLY removed as Supabase migrations run inside a
-- transaction pipeline. Tables are small enough that brief locks are fine.

-- 1. booking_payments(booking_id, status) — used by balance checks
--    and payment verification on every booking detail page load.
CREATE INDEX IF NOT EXISTS idx_booking_payments_booking_status
  ON booking_payments (booking_id, status);

-- 2. bookings(contract_id, booking_date, status) — used by monthly
--    quota calculation, billing statement generation, and the
--    accounting monthly summary page.
CREATE INDEX IF NOT EXISTS idx_bookings_contract_date_status
  ON bookings (contract_id, booking_date, status);

-- 3. usage_charges(billing_statement_id) — used when recomputing
--    statement totals after adding a charge.
CREATE INDEX IF NOT EXISTS idx_usage_charges_statement
  ON usage_charges (billing_statement_id);

-- 4. contract_payments(contract_id, status) — used by balance
--    calculations on contract detail and billing pages.
CREATE INDEX IF NOT EXISTS idx_contract_payments_contract_status
  ON contract_payments (contract_id, status);

-- 5. bookings(booking_date, status) — used by the daily bookings
--    list page which queries today's bookings by date + status.
CREATE INDEX IF NOT EXISTS idx_bookings_date_status
  ON bookings (booking_date, status);
