-- Add GST fields to bookings table
-- Conference room bookings attract 18% GST in India
-- total_amount stores the pre-GST (base) amount
-- total_amount_with_gst stores the GST-inclusive amount sent to payment links

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS gst_rate DECIMAL(5,2) DEFAULT 18,
  ADD COLUMN IF NOT EXISTS gst_amount DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_amount_with_gst DECIMAL(12,2) DEFAULT 0;

-- Backfill existing bookings: assume 18% GST on total_amount
UPDATE bookings
SET
  gst_rate = 18,
  gst_amount = ROUND(total_amount * 0.18, 2),
  total_amount_with_gst = ROUND(total_amount * 1.18, 2)
WHERE total_amount_with_gst = 0 OR total_amount_with_gst IS NULL;
