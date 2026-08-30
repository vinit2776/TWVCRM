-- Statement write-off (CRM-only bad-debt tracking)
--
-- Void is for "the invoice was wrong, redo it": it un-links usage_charges/
-- bookings/service_usage_records back to unbilled and spins up a fresh draft
-- with the same amounts (src/app/api/billing-statements/[id]/void/route.ts).
-- That's the wrong shape for a correctly-billed invoice the customer simply
-- can't or won't pay — voiding it just regenerates the same receivable next
-- cycle. Write-off is the other exit: the document stays exactly as issued
-- (GST invoice number, Tally record, existing payments untouched), only the
-- CRM's own AR-chasing status changes.
--
-- payment_status is plain TEXT (00075_billing_operations.sql), not an enum —
-- no ALTER TYPE ADD VALUE split-migration dance needed here.

ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS written_off_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS written_off_by     UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS write_off_reason   TEXT,
  ADD COLUMN IF NOT EXISTS written_off_amount NUMERIC(12,2);

CREATE INDEX IF NOT EXISTS idx_billing_statements_written_off
  ON billing_statements (written_off_at)
  WHERE written_off_at IS NOT NULL;
