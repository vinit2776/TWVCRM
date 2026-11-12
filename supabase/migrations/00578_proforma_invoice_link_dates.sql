-- When an ad-hoc invoice's Razorpay payment link was generated and when it
-- stops working, so the invoice list can show it next to "Copy link" (the
-- INV-0060 link silently expired and nobody could tell from the CRM). Both
-- come from Razorpay's own response (created_at / expire_by). NULL for links
-- created before this migration. Existing RLS on proforma_invoices covers
-- the new columns.
ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS razorpay_link_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS razorpay_link_expires_at TIMESTAMPTZ;

-- Rollback: ALTER TABLE proforma_invoices
--   DROP COLUMN razorpay_link_created_at, DROP COLUMN razorpay_link_expires_at;
