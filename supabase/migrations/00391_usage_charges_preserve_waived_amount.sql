-- Preserve the pre-waive amounts on usage_charges.
--
-- Waiving a charge (PATCH /api/usage-charges/[id] with status='waived')
-- deliberately zeroes unit_price/total/gst_amount/total_with_gst, because
-- several billing screens read `total` directly without checking status —
-- a non-zero total on a waived row reads as "still being charged".
--
-- The side effect was that the original figure became unrecoverable, so a
-- transaction breakdown could not show "Overtime ₹2,750.58 — waived by X".
-- These columns snapshot the amounts at waive time so the UI can render the
-- struck-through original alongside who waived it, without changing the
-- zeroing behaviour that other screens depend on.
ALTER TABLE usage_charges
  ADD COLUMN IF NOT EXISTS original_unit_price    NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS original_total         NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS original_gst_amount    NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS original_total_with_gst NUMERIC(12,2);

COMMENT ON COLUMN usage_charges.original_total_with_gst IS
  'Amount before waiving. NULL for non-waived charges. Set at waive time; the live amount columns are zeroed.';
