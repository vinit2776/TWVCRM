-- Link bookings to their billing statement so the monthly-summary
-- can filter out bookings that are already included in a statement.
--
-- Problem: billing.ts marks usage_charges.status = 'billed' and
-- service_usage_records.is_billed = true when generating a statement,
-- but it never updates bookings. As a result, posted_to_bill bookings
-- kept appearing as "Unbilled Bookings" in the Contracts tab even after
-- the billing statement was finalized.
--
-- Fix: billing.ts now sets bookings.billing_statement_id when a statement
-- is generated, and void/route.ts clears it when a statement is voided
-- (so those bookings can be picked up by the replacement draft).

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS billing_statement_id UUID
    REFERENCES billing_statements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_billing_statement_id
  ON bookings (billing_statement_id);
