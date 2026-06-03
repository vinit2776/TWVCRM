-- Repair: ensure pi_cancelled_at and related columns exist on billing_statements.
-- Migration 00229 was tracked as applied but the ALTER TABLE never executed.

ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS pi_cancelled_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pi_cancelled_by       UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS pi_override_reason    TEXT,
  ADD COLUMN IF NOT EXISTS gst_invoice_due_date  DATE;
