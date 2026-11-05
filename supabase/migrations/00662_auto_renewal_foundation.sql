-- Auto-renewal, part 1: the data and settings the later parts build on.
--
-- Nothing in this migration changes what a customer sees or is billed. No job
-- reads these columns yet; auto_renew defaults to false everywhere, so every
-- contract keeps today's manual renewal until a person switches it on.
--
-- Rollback (all additive):
--   ALTER TABLE contracts
--     DROP COLUMN IF EXISTS auto_renew,
--     DROP COLUMN IF EXISTS auto_renew_stopped_at,
--     DROP COLUMN IF EXISTS auto_renew_stopped_by,
--     DROP COLUMN IF EXISTS auto_renew_stop_reason,
--     DROP COLUMN IF EXISTS agreement_escalation_percentage;
--   DELETE FROM app_settings WHERE key LIKE 'auto_renew_%';

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_renew_stopped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_renew_stopped_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS auto_renew_stop_reason TEXT,
  ADD COLUMN IF NOT EXISTS agreement_escalation_percentage NUMERIC(5,2)
    CHECK (agreement_escalation_percentage IS NULL
           OR (agreement_escalation_percentage >= 0 AND agreement_escalation_percentage <= 100));

COMMENT ON COLUMN contracts.auto_renew IS
  'Whether the daily auto-renew job may prepare and roll this contract into its next term. Off by default; a person switches it on per contract.';
COMMENT ON COLUMN contracts.auto_renew_stop_reason IS
  'Why auto-renewal was last switched off (customer notice recorded, declined, paused by staff). Cleared when switched back on.';
COMMENT ON COLUMN contracts.agreement_escalation_percentage IS
  'The escalation written into the signed base agreement, carried unchanged down a renewal chain. escalation_percentage is what was APPLIED to this term, which a negotiation may set differently for that one term only. NULL means the two are the same.';

-- The job's daily scan is "auto-renew on, live, ending soon".
CREATE INDEX IF NOT EXISTS idx_contracts_auto_renew_end_date
  ON contracts (end_date)
  WHERE auto_renew = true AND status IN ('active', 'renewal_in_progress');

-- Renewals created before this column existed may carry a one-off negotiated
-- percentage in escalation_percentage. The base agreement's figure is the
-- chain root's, so record that. Touches renewal rows only; roots keep NULL and
-- read their own escalation_percentage.
WITH RECURSIVE chain AS (
  SELECT id, id AS root_id
    FROM contracts
   WHERE parent_contract_id IS NULL
  UNION ALL
  SELECT c.id, ch.root_id
    FROM contracts c
    JOIN chain ch ON c.parent_contract_id = ch.id
)
UPDATE contracts c
   -- A stored 0 or missing figure reads as 10, because that is what the signed
   -- agreement PDF prints for it (escalation_percentage || 10).
   SET agreement_escalation_percentage = CASE WHEN r.escalation_percentage > 0 THEN r.escalation_percentage ELSE 10 END
  FROM chain ch
  JOIN contracts r ON r.id = ch.root_id
 WHERE c.id = ch.id
   AND c.parent_contract_id IS NOT NULL
   AND c.agreement_escalation_percentage IS NULL;

-- Settings. The job's mode is dry_run so that scheduling it later cannot reach
-- anyone by itself (same convention as vo_renewal_cron_mode).
INSERT INTO app_settings (key, value) VALUES ('auto_renew_cron_mode', 'dry_run')
  ON CONFLICT (key) DO NOTHING;
-- Days before the customer notice that the internal draft is prepared.
INSERT INTO app_settings (key, value) VALUES ('auto_renew_draft_lead_days', '7')
  ON CONFLICT (key) DO NOTHING;
-- Days before each contract's notice deadline that notice #1 goes out.
INSERT INTO app_settings (key, value) VALUES ('auto_renew_notice_lead_days', '7')
  ON CONFLICT (key) DO NOTHING;
-- Days before the end date for the rate confirmation (skipped if notice #1 is later).
INSERT INTO app_settings (key, value) VALUES ('auto_renew_confirmation_days', '15')
  ON CONFLICT (key) DO NOTHING;
