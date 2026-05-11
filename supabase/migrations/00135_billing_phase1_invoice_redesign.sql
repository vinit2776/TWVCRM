-- Phase 1: Invoice redesign — itemized line items, prepaid rent + usage structure
--
-- Changes:
--   1. Add line_items JSONB to billing_statements for sectioned invoice breakdown
--   2. Add prepaid_month / prepaid_year to track which future month the rent covers
--   3. Add booking_line_items to store auto-rolled contract bookings
--   4. Add service_usage_amount to break out the third charge system
--
-- The new invoice structure (generated on last day of month M at 21:00 IST):
--   Section A: Prepaid rent for month M+1
--   Section B: Current month (M) itemized usage
--     - Contract bookings (auto-rolled, free quota at ₹0, paid at actuals)
--     - Ad-hoc usage charges (manual entries)
--     - Facility usage records (meeting room quota overages)
--     - Service usage records (printer/service overages) — previously silently dropped
--   Section C: Free quota summary (informational)

-- 1. Structured line items — the full invoice breakdown as rendered on the PDF
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS line_items JSONB DEFAULT '[]'::JSONB;

COMMENT ON COLUMN billing_statements.line_items IS
  'Sectioned invoice breakdown: [{type, label, items: [{...}], subtotal}]. '
  'Types: prepaid_rent, booking_usage, ad_hoc_charges, facility_usage, service_usage.';

-- 2. Track which future month the prepaid rent covers
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS prepaid_month INTEGER,
  ADD COLUMN IF NOT EXISTS prepaid_year  INTEGER;

-- 3. Separate out service usage amount (was silently dropped before)
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS service_usage_amount DECIMAL(12,2) DEFAULT 0;

-- 4. Track booking usage amount separately from ad-hoc usage
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS booking_usage_amount DECIMAL(12,2) DEFAULT 0;

-- 5. Index for finding statements by prepaid period
CREATE INDEX IF NOT EXISTS idx_billing_statements_prepaid
  ON billing_statements(prepaid_year, prepaid_month)
  WHERE prepaid_month IS NOT NULL;
