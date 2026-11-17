-- A proposal now states two things separately: the monthly fee (which escalates
-- by an agreed percentage) and recurring add-ons (never escalated, can be
-- withdrawn mid-contract).
--
--   recurring_addons       [{ description, amount }] monthly add-ons offered with
--                          the proposal. Not part of subtotal, so the security
--                          deposit (months x subtotal) never counts them. When
--                          the contract is created they become contract_addons
--                          rows dated to the contract term.
--   escalation_percentage  The agreed annual escalation on the monthly fee,
--                          default 10. Prefilled into the contract.
--
-- Rollback:
--   ALTER TABLE proposals DROP COLUMN recurring_addons, DROP COLUMN escalation_percentage;
-- (RLS already covers proposals; no policy change needed.)

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS recurring_addons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS escalation_percentage numeric(5,2) NOT NULL DEFAULT 10
    CHECK (escalation_percentage >= 0 AND escalation_percentage <= 100);

COMMENT ON COLUMN proposals.recurring_addons IS
  'Monthly add-ons offered with the proposal, [{description, amount}]. Never escalated; excluded from subtotal and the security deposit.';
COMMENT ON COLUMN proposals.escalation_percentage IS
  'Agreed annual escalation on the monthly fee (line items only). Default 10.';
