-- Records that a statement's rent — some or all of it — belongs to a contract
-- other than the one it was raised against.
--
-- This happens on renewal. While a parent contract is `renewal_in_progress`
-- and its renewal has not been activated yet, the parent is the only billable
-- contract, so the month-end run bills it for days past its own end_date at the
-- RENEWAL's rate (see computeRenewalSplitRentSegments). The money and the GST
-- are right — same customer, same GSTIN, same amount — but the statement is
-- attributed to a contract whose term has ended, and the renewal's own billing
-- history reads as empty for months it was actually occupied and paid for.
--
-- Without this column that attribution is unrecoverable after the fact: nothing
-- on the statement says which contract the rent was really for. Reports, AR and
-- the unbilled-month detector all have to guess by walking the renewal chain.
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS billed_on_behalf_of_contract_id UUID
    REFERENCES contracts(id) ON DELETE SET NULL;

COMMENT ON COLUMN billing_statements.billed_on_behalf_of_contract_id IS
  'Set when this statement bills rent for a period belonging to another contract '
  '(a renewal billed on its parent while awaiting activation). The statement stays '
  'owned by contract_id for accounting and GST; this records where the rent belongs.';

-- Partial index: only a small minority of statements ever carry the tag, and
-- every read of it filters for NOT NULL ("what was billed for this renewal").
CREATE INDEX IF NOT EXISTS idx_billing_statements_billed_on_behalf
  ON billing_statements (billed_on_behalf_of_contract_id)
  WHERE billed_on_behalf_of_contract_id IS NOT NULL;
