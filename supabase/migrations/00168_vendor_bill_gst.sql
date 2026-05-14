-- Add GST fields to vendor_bills.
--
-- POs are always raised at base value (without GST). The vendor invoice
-- includes GST. This migration captures the applicable rate and derived
-- GST amount so the payment ceiling in Acc Payables can be:
--   approved_amount (base) + gst_amount = actual payable to vendor.
--
-- gst_rate  — the GST slab: 0 / 5 / 12 / 18 / 28
-- gst_amount — computed: base_amount × gst_rate / 100  (or entered manually)
-- base_amount — the pre-GST invoice value (total_amount − gst_amount)
--               stored explicitly to avoid re-deriving it everywhere.

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS gst_rate    DECIMAL(5,2)  DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS gst_amount  DECIMAL(12,2) DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS base_amount DECIMAL(12,2);

-- Back-fill base_amount for existing rows:
-- Since no GST was recorded before, base_amount = total_amount for all existing bills.
UPDATE vendor_bills SET base_amount = total_amount WHERE base_amount IS NULL;

ALTER TABLE vendor_bills
  ALTER COLUMN base_amount SET DEFAULT 0,
  ALTER COLUMN base_amount SET NOT NULL;
