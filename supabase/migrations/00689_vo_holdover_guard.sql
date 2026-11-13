-- VO address watch (part 2): idempotency guard and approval switch for holdover proformas.
--
-- One live holdover statement per case and cycle. reference_note carries
-- TWV-HO-<case digits>-C<cycle>, so a second run of the cron for the same
-- period hits this index instead of raising a second bill.
--
-- vo_holdover_clause_approved gates the billing path: the holdover clause in
-- the terms library needs legal sign-off, and until this is 'true' the cron
-- never creates a holdover draft, whatever its mode.
--
-- Rollback: DROP INDEX IF EXISTS uq_billing_statements_vo_holdover;
--           DELETE FROM app_settings WHERE key = 'vo_holdover_clause_approved';

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_statements_vo_holdover
  ON billing_statements (case_id, reference_note)
  WHERE statement_type = 'vo_holdover' AND status NOT IN ('voided', 'discarded');

INSERT INTO app_settings (key, value) VALUES ('vo_holdover_clause_approved', 'false')
ON CONFLICT (key) DO NOTHING;
