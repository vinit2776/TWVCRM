-- billing_statements.reference_note
--
-- src/lib/vo-renewal.ts writes reference_note (the proforma number, PI-xxxx)
-- when it creates a Virtual Office renewal bill, but no earlier migration ever
-- created the column. Staging has no such column, so the insert fails there;
-- IF NOT EXISTS makes this safe on any database that already has it (for
-- example one where it was added by hand).
--
-- Rollback: ALTER TABLE billing_statements DROP COLUMN IF EXISTS reference_note;
-- (only if nothing has been written to it yet).

ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS reference_note TEXT;
