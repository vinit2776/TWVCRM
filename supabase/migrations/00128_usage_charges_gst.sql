-- ============================================================
-- Migration 00128: GST fields on usage_charges
-- ============================================================
-- usage_charges.total has historically been stored as the ex-GST
-- subtotal, with no breakdown for the tax component. That made:
--   - the AddUsageChargeDialog GST-blind (the user couldn't see what
--     would actually be billed once tax was applied)
--   - monthly statements understate the true receivable until the
--     statement-generation step bolted GST on top
--   - the new "Collect Now Anyway" flow on a contract booking unable
--     to reconcile with the GST-inclusive booking total
--
-- This migration adds the same three columns the booking-addons table
-- already carries:
--   gst_rate        — percentage applied at the time the charge was logged
--   gst_amount      — ₹ value of the tax component
--   total_with_gst  — convenience total = total + gst_amount
--
-- All three are nullable + default 0 so existing rows remain valid
-- without a backfill — they were created GST-free and stay that way.
-- ============================================================

ALTER TABLE usage_charges
  ADD COLUMN IF NOT EXISTS gst_rate       NUMERIC(5, 2)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gst_amount     NUMERIC(12, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_with_gst NUMERIC(12, 2);

-- Backfill total_with_gst for existing rows so it's never null when
-- the statement generator picks them up. For pre-migration rows the
-- value equals total (no GST was applied at the time).
UPDATE usage_charges
   SET total_with_gst = total + COALESCE(gst_amount, 0)
 WHERE total_with_gst IS NULL;

-- Going forward enforce the convenience invariant.
ALTER TABLE usage_charges
  ALTER COLUMN total_with_gst SET DEFAULT 0,
  ALTER COLUMN total_with_gst SET NOT NULL;
