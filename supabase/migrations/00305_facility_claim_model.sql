-- Migration 00305: Facility issue claim model
-- Adds claimed_at, claim_sla_target_at, claim_sla_breached to track
-- time-to-claim accountability separate from time-to-resolve SLA.

ALTER TABLE facility_issues
  ADD COLUMN IF NOT EXISTS claimed_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_sla_target_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_sla_breached  BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for the cron query: unowned open tickets past their claim SLA deadline
CREATE INDEX IF NOT EXISTS idx_facility_issues_claim
  ON facility_issues (status, assigned_to, claim_sla_breached)
  WHERE claim_sla_breached = FALSE;

-- Backfill: tickets that were already acknowledged had an implicit claim moment
UPDATE facility_issues
SET claimed_at = acknowledged_at
WHERE acknowledged_at IS NOT NULL
  AND claimed_at IS NULL;
