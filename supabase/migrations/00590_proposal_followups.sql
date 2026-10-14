-- Proposal expiry + customer nudges.
--
-- The daily /api/cron/proposal-followups job (a) emails the customer twice
-- while a proposal sits unanswered, (b) tells the rep once to call, and
-- (c) flips lapsed proposals to 'expired'. Each step is stamped here so a
-- re-run never sends the same nudge twice.
--
-- Rollback: ALTER TABLE proposals DROP COLUMN nudge_1_sent_at, DROP COLUMN
-- nudge_2_sent_at, DROP COLUMN rep_followup_notified_at, DROP COLUMN
-- expired_at, DROP COLUMN validity_extensions; DELETE FROM app_settings
-- WHERE key = 'proposal_followups_enabled';

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS nudge_1_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS nudge_2_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rep_followup_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validity_extensions INTEGER NOT NULL DEFAULT 0;

-- Customer-facing sends ship dark: off until an admin turns it on.
INSERT INTO app_settings (key, value)
VALUES ('proposal_followups_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
