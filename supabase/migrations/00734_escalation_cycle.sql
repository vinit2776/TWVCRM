-- Escalation cycle: the agreed fee steps up every N months inside the term
-- (11 by default, 12 on request) instead of only at renewal.
-- NULL = no in-term steps, today's behaviour. Every existing proposal and
-- contract stays NULL, so nothing already signed changes.
-- The stepped fees themselves are kept in contract_rate_phases (generated from
-- these columns, locked once the agreement is sent), so billing is unchanged.
-- Rollback: ALTER TABLE proposals DROP COLUMN escalation_cycle_months;
--           ALTER TABLE contracts DROP COLUMN escalation_cycle_months;

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS escalation_cycle_months smallint
  CHECK (escalation_cycle_months IS NULL OR escalation_cycle_months IN (11, 12));

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS escalation_cycle_months smallint
  CHECK (escalation_cycle_months IS NULL OR escalation_cycle_months IN (11, 12));
