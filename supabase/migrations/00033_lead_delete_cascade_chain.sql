-- Complete the cascade chain so that deleting a lead with contracts/billing
-- records works end-to-end.
--
-- After 00032 fixed lead_id FKs to CASCADE, PostgreSQL still hits RESTRICT
-- on the contract-level FKs when it tries to cascade-delete contracts or
-- proposals that were themselves cascade-deleted from the lead:
--
--   leads → proposals (CASCADE) → contracts.proposal_id (RESTRICT) → FAIL
--   leads → contracts (CASCADE) → billing_statements.contract_id (RESTRICT) → FAIL
--   leads → contracts (CASCADE) → usage_charges.contract_id (RESTRICT) → FAIL
--
-- Fix: SET NULL for the proposal back-reference (a contract can survive
-- without its originating proposal), CASCADE for billing/usage records
-- (they are purely financial data owned by the contract).

-- contracts.proposal_id: SET NULL so deleting a proposal doesn't block it
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_proposal_id_fkey;
ALTER TABLE contracts ADD CONSTRAINT contracts_proposal_id_fkey
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE SET NULL;

-- billing_statements.contract_id: CASCADE — billing rows are owned by the contract
ALTER TABLE billing_statements DROP CONSTRAINT IF EXISTS billing_statements_contract_id_fkey;
ALTER TABLE billing_statements ADD CONSTRAINT billing_statements_contract_id_fkey
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE;

-- usage_charges.contract_id: CASCADE — usage rows are owned by the contract
ALTER TABLE usage_charges DROP CONSTRAINT IF EXISTS usage_charges_contract_id_fkey;
ALTER TABLE usage_charges ADD CONSTRAINT usage_charges_contract_id_fkey
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE;
