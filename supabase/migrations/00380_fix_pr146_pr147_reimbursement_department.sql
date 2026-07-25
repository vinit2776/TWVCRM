-- Manual correction: PR-2607-146 (coffee materials, ₹6,453) and PR-2607-147
-- (coffee machine rental, ₹3,000) were both raised 2026-07-07 for Clix Capital
-- Services Pvt Ltd's office pantry ("VRK" vendor) and admin ("JMV" vendor)
-- costs, which should be billed back to the customer. The 'reimbursement'
-- department + customer bill-back flow (billable_contract_id, bill-customer
-- API, "Bill Customer" button) didn't ship until migration 00349 on
-- 2026-07-16 — these two MRs predate the feature, so they were filed under
-- the closest available departments (pantry / administration) instead.
--
-- Both MRs are already approved with POs placed and vendor bills uploaded
-- (pending approval, unpaid) — nothing on the vendor-payment side needs to
-- change. Fixing department + billable_contract_id is sufficient: the MR
-- detail page's GET route already joins billable_contract and
-- reimbursement_statements, so the "Bill Customer" button will appear as
-- soon as these two columns are corrected.
--
-- Contract: TWV-C-0093 (Clix Capital Services Pvt Ltd, active, Capital Towers).

UPDATE purchase_requests
SET
  department = 'reimbursement',
  billable_contract_id = 'c513890c-e12c-4266-94e7-4e161c57194a'
WHERE pr_number IN ('PR-2607-146', 'PR-2607-147')
  AND department IN ('pantry', 'administration');
