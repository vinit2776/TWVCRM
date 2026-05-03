-- ============================================================
-- 00123: Performance indexes for hot read paths
--
-- Three composite / partial indexes that back queries hit on every
-- dashboard load. Pure additions; no behaviour change.
--
--   1. contract_documents  → KYC pending dashboard + Saturday cron
--      (filters is_required=true AND status IN pending/deferred)
--   2. bookings             → walk-in payment-required gate
--      (filters status='confirmed' AND payment_status='pending')
--   3. service_usage_records → monthly statement generation
--      (lookup by contract + period when computing add-on lines)
--
-- All use IF NOT EXISTS so the migration is safe to rerun.
-- ============================================================

-- ── contract_documents — KYC dashboard + cron ────────────────────────────
-- Both queries do: WHERE is_required = true AND status IN ('pending','deferred')
-- Without a composite, Postgres scans the whole table and filters in memory.
CREATE INDEX IF NOT EXISTS idx_contract_docs_required_status
  ON contract_documents(is_required, status)
  WHERE is_required = true;

-- ── bookings — walk-in payment gate ──────────────────────────────────────
-- The check-in payment gate scans for "confirmed walk-in bookings whose
-- payment is still pending". A partial index makes this an index-only
-- scan even on millions of historical rows.
CREATE INDEX IF NOT EXISTS idx_bookings_pending_walkin_payment
  ON bookings(payment_status, customer_type, status)
  WHERE status = 'confirmed' AND payment_status <> 'paid';

-- ── service_usage_records — statement generation ─────────────────────────
-- generateMonthlyStatements looks up "did we already record usage for
-- this contract in this period?" before billing. Composite avoids three
-- separate single-column index lookups.
CREATE INDEX IF NOT EXISTS idx_sur_contract_period
  ON service_usage_records(contract_id, period_year, period_month);
