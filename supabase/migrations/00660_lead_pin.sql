-- Pinned leads: someone marks a lead "keep this in front of the team". A pinned lead is highlighted
-- in the Leads list and shown in a band on every calendar day, whatever its follow-up date, until
-- someone unpins it. One shared pin per lead (not per person).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pinned_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_pinned ON leads (pinned_at) WHERE pinned_at IS NOT NULL;

-- No new policy: leads already has RLS, and pinning is an ordinary update of a lead row.

-- Rollback:
--   DROP INDEX IF EXISTS idx_leads_pinned;
--   ALTER TABLE leads DROP COLUMN IF EXISTS pinned_by, DROP COLUMN IF EXISTS pinned_at;
