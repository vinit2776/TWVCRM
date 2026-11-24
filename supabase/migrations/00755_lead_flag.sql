-- A flag on a lead: anyone who works leads can mark one for attention with a reason, and the Leads
-- sheet shows the whole row in the flag colour with the reason on hover. Cleared by setting all three
-- back to NULL. Additive; nothing reads these until the sheet's flag control ships.
-- Rollback:
--   ALTER TABLE leads DROP COLUMN IF EXISTS flagged_at, DROP COLUMN IF EXISTS flagged_by, DROP COLUMN IF EXISTS flag_reason;
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS flagged_at timestamptz,
  ADD COLUMN IF NOT EXISTS flagged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS flag_reason text;

CREATE INDEX IF NOT EXISTS leads_flagged_at_idx ON leads (flagged_at) WHERE flagged_at IS NOT NULL;
