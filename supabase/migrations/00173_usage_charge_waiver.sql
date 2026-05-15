-- Add waiver support to usage_charges
-- Waived charges stay in record but are excluded from billing totals.
-- Only admin/manager can waive; requires a typed reason.

ALTER TABLE usage_charges
  ADD COLUMN IF NOT EXISTS is_waived    BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS waived_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS waived_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS waive_reason TEXT;

-- Index so we can quickly sum non-waived charges per statement
CREATE INDEX IF NOT EXISTS idx_usage_charges_is_waived
  ON usage_charges(billing_statement_id, is_waived)
  WHERE billing_statement_id IS NOT NULL;
