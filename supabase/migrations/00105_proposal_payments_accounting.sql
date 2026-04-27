-- Track which proposal-level payments have been entered into the accounting system.
-- "Accounted" means the accounts team has recorded this entry in their books/GST filing.

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_accounted       BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deposit_accounted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_accounted_by    TEXT; -- auth user id

ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS accounted               BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS accounted_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accounted_by            TEXT; -- auth user id

ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS accounted               BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS accounted_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accounted_by            TEXT; -- auth user id
