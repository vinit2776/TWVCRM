-- Per-bill landlord GST override for electricity sub-billing.
--
-- Some landlords charge GST on their electricity bill, some don't — and this
-- can vary from what the location's default config assumes. Previously,
-- landlord GST was only a one-time per-location setting
-- (location_electricity_config.landlord_gst_applicable/landlord_gst_rate)
-- that silently drove the auto-created vendor bill's gst_amount — it wasn't
-- visible or editable at bill-capture time, and if a location had no
-- landlord_vendor_id mapped (no auto vendor bill), the GST was never
-- recorded anywhere at all.
--
-- This adds the same fields directly to electricity_bills so each month's
-- capture can override the default, and the amount is always visible on the
-- bill itself regardless of whether a vendor bill exists.
--
-- Rollback:
--   ALTER TABLE electricity_bills DROP COLUMN IF EXISTS landlord_gst_applicable;
--   ALTER TABLE electricity_bills DROP COLUMN IF EXISTS landlord_gst_rate;
--   ALTER TABLE electricity_bills DROP COLUMN IF EXISTS landlord_gst_amount;

ALTER TABLE electricity_bills
  ADD COLUMN IF NOT EXISTS landlord_gst_applicable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS landlord_gst_rate NUMERIC(5,2) DEFAULT 18
    CHECK (landlord_gst_rate IS NULL OR landlord_gst_rate >= 0),
  ADD COLUMN IF NOT EXISTS landlord_gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
