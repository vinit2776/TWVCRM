-- Customer journey: last onboarding step ("welcome done") is recorded by staff.
-- Nothing is sent to the customer; this only records that staff confirmed the
-- customer has been welcomed and has their access.
-- contracts already has RLS enabled; no new table, so no new policy needed.
--
-- Rollback:
--   ALTER TABLE contracts DROP COLUMN IF EXISTS welcome_done_at, DROP COLUMN IF EXISTS welcome_done_by;

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS welcome_done_at timestamptz,
  ADD COLUMN IF NOT EXISTS welcome_done_by uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN contracts.welcome_done_at IS
  'When staff marked the customer as welcomed (final journey onboarding step). Manual; nothing is sent.';
