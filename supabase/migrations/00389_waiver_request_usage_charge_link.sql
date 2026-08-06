-- Link a waiver_requests row to the specific usage_charges row it targets.
-- Without this, the approval step had to guess "the most recent pending
-- waiver request for this booking" and had no direct way to know which
-- usage_charges row to flip to status='waived' — it never touched
-- usage_charges at all (see 00390 for why that mattered).
ALTER TABLE waiver_requests
  ADD COLUMN IF NOT EXISTS usage_charge_id UUID REFERENCES usage_charges(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_waiver_requests_usage_charge_id
  ON waiver_requests(usage_charge_id)
  WHERE usage_charge_id IS NOT NULL;
