-- ─────────────────────────────────────────────────────────────────────────────
-- 00180_accounting_heads.sql
-- Adds accounting-head labels to receivables and manual tagging to payables.
--
-- Receivables: every payment now carries a primary_head so accounts knows
--   whether to post as Security Deposit, Membership Fee, Usage Charge, etc.
-- Payables: vendor bills that are NOT linked to a PO can be manually tagged
--   with department + expenditure type so accounts knows OpEx vs CapEx.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. New enum: receivable accounting heads ──────────────────────────────────
CREATE TYPE accounting_head AS ENUM (
  'security_deposit',   -- Refundable; not revenue; no GST
  'membership_fee',     -- Fixed monthly rent / workspace fee; GST 18%
  'usage_charge',       -- Meeting rooms, facility hours; GST 18%
  'setup_fee',          -- One-time joining / activation; GST 18%
  'late_fee',           -- Penalty / interest; GST 18%
  'other_income'        -- Ad-hoc catch-all; GST 18% (default)
);

-- ── 2. Billing statements: default to membership_fee ─────────────────────────
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS primary_head accounting_head DEFAULT 'membership_fee';

-- Backfill: all existing rows are membership fee billings
UPDATE billing_statements
SET primary_head = 'membership_fee'
WHERE primary_head IS NULL;

-- ── 3. Proforma invoices: default to other_income ────────────────────────────
ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS primary_head accounting_head DEFAULT 'other_income';

-- Backfill: heuristic classification from title
UPDATE proforma_invoices
SET primary_head = 'security_deposit'
WHERE primary_head = 'other_income'
  AND (
    LOWER(title) LIKE '%deposit%'
    OR LOWER(title) LIKE '%security%'
  );

UPDATE proforma_invoices
SET primary_head = 'usage_charge'
WHERE primary_head = 'other_income'
  AND (
    LOWER(title) LIKE '%meeting%'
    OR LOWER(title) LIKE '%usage%'
    OR LOWER(title) LIKE '%facility%'
    OR LOWER(title) LIKE '%booking%'
    OR LOWER(title) LIKE '%room%'
  );

UPDATE proforma_invoices
SET primary_head = 'setup_fee'
WHERE primary_head = 'other_income'
  AND (
    LOWER(title) LIKE '%setup%'
    OR LOWER(title) LIKE '%joining%'
    OR LOWER(title) LIKE '%activation%'
    OR LOWER(title) LIKE '%onboarding%'
  );

-- ── 4. Contract payments: tag each payment with what it settled ───────────────
ALTER TABLE contract_payments
  ADD COLUMN IF NOT EXISTS allocated_head accounting_head;

-- ── 5. Vendor bills: manual tagging for direct expenses (no PO) ──────────────
-- When po_id is set, department comes from purchase_orders → purchase_requests.
-- When po_id is null (direct expense), these fields capture the accounting class.
ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS manual_department procurement_department,
  ADD COLUMN IF NOT EXISTS manual_expenditure_type TEXT
    CHECK (manual_expenditure_type IN ('operational', 'amc', 'capital'));
