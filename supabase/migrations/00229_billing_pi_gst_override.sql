-- Migration: PI → GST early override support
--
-- Adds fields to billing_statements to track when a proforma invoice has been
-- superseded by an early GST invoice (before payment), and explicit due-date
-- for that early-issued GST invoice (immediate, not the normal 7-day window).

ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS pi_cancelled_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pi_cancelled_by       UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS pi_override_reason    TEXT,
  ADD COLUMN IF NOT EXISTS gst_invoice_due_date  DATE;

COMMENT ON COLUMN billing_statements.pi_cancelled_at IS
  'Set when a proforma invoice is superseded by an early GST invoice via the AR override action. NULL for standard flow.';

COMMENT ON COLUMN billing_statements.pi_override_reason IS
  'Reason entered by admin/manager when triggering the PI → early GST override.';

COMMENT ON COLUMN billing_statements.gst_invoice_due_date IS
  'Explicit due date for an early-issued GST invoice (override path). '
  'For the standard flow (post-payment), this is NULL — the invoice is already paid.';
