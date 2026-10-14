-- Renewal auto-draft.
--
-- A daily job (/api/cron/renewal-autodraft) creates the renewal draft once a
-- contract is within 45 days of its end_date. An auto-created draft must be
-- validated by a person (renewal_validated_at) before it can be e-mailed or
-- sent for e-signing. Manual drafts are unaffected (renewal_auto_created
-- stays false and nothing gates them).
--
-- Rollback: ALTER TABLE contracts DROP COLUMN renewal_auto_created, DROP
-- COLUMN renewal_auto_created_at, DROP COLUMN renewal_validated_at, DROP
-- COLUMN renewal_validated_by, DROP COLUMN renewal_validation_nudged_at;
-- DELETE FROM app_settings WHERE key IN ('renewal_autodraft_enabled');

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS renewal_auto_created BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS renewal_auto_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS renewal_validated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS renewal_validated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS renewal_validation_nudged_at TIMESTAMPTZ;

-- Ships dark: nothing is drafted until an admin turns it on.
INSERT INTO app_settings (key, value)
VALUES ('renewal_autodraft_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
