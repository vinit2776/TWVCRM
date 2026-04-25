-- Track replacement lineage between vendor bills.
-- When an invoice is rejected with rejection_outcome='replacement' and the user
-- re-uploads a corrected invoice, the new bill records the previous bill's id
-- in replaces_bill_id. This gives deterministic lineage without relying on
-- vendor/amount heuristics.

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS replaces_bill_id UUID
    REFERENCES vendor_bills(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_bills_replaces
  ON vendor_bills(replaces_bill_id)
  WHERE replaces_bill_id IS NOT NULL;
