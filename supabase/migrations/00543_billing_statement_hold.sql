-- Lets accounts/admin temporarily block a single billing statement from
-- being sent or GST-issued while something on it is being clarified or
-- corrected — without freezing the draft itself, and without any special
-- "cancel" step (release it when done). Distinct from
-- contract_billing_moratoriums, which waives an entire billing month.
--
-- held_at IS NOT NULL is the "currently held" signal — releasing nulls all
-- three columns. Full history of who held/released and when lives in
-- audit_trail (statement_held / statement_hold_released), same as
-- everywhere else in this codebase; no need to preserve past holds here.
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS held_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS hold_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_billing_statements_held
  ON billing_statements (held_at)
  WHERE held_at IS NOT NULL;
