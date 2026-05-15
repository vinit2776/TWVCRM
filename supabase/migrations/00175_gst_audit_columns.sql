-- Track who set/changed the GST amount on a vendor bill, and who
-- explicitly confirmed "no GST" when the amount was set to zero.

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS gst_set_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gst_set_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gst_zero_confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS gst_zero_confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN vendor_bills.gst_set_by           IS 'User who last set or changed gst_amount';
COMMENT ON COLUMN vendor_bills.gst_set_at           IS 'Timestamp when gst_amount was last set or changed';
COMMENT ON COLUMN vendor_bills.gst_zero_confirmed   IS 'True when gst_amount = 0 was explicitly confirmed by an authorised user';
COMMENT ON COLUMN vendor_bills.gst_zero_confirmed_by IS 'User who confirmed the zero-GST declaration';
