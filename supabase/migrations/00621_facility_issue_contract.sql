-- Which customer a facility ticket is about.
--
-- facility_issues recorded a location and, optionally, a space unit, but never
-- the customer. Staff log nearly every ticket on a customer's behalf, so the
-- reporter fields hold staff details, and the unit is filled in on a small
-- share of tickets. The lead's Value tab could therefore tie only about one in
-- ten tickets to a customer.
--
-- contract_id lets whoever logs a ticket say which customer it is about
-- (optional). It points at the contract, so the customer follows from
-- contracts.lead_id, and a customer with two contracts is told apart. ON DELETE
-- SET NULL: removing a contract must never delete a ticket.
--
-- No RLS change: facility_issues already has its policies. Existing tickets keep
-- NULL. There is no backfill; the information was never recorded.
--
-- Rollback: ALTER TABLE facility_issues DROP COLUMN contract_id;

ALTER TABLE facility_issues
  ADD COLUMN IF NOT EXISTS contract_id uuid REFERENCES contracts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_facility_issues_contract
  ON facility_issues (contract_id)
  WHERE contract_id IS NOT NULL;

COMMENT ON COLUMN facility_issues.contract_id IS
  'Optional: the contract (and so the customer) this ticket is about, chosen when the ticket is logged. NULL when unknown or not customer-specific.';
