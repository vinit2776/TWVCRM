-- Migration: Add Razorpay Payment Link fields to bookings
-- This supports the Razorpay Payment Links API integration

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS razorpay_payment_link_id TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_payment_link_url TEXT;

-- Index for looking up bookings by payment link ID (webhook handling)
CREATE INDEX IF NOT EXISTS idx_bookings_razorpay_payment_link_id ON bookings(razorpay_payment_link_id) WHERE razorpay_payment_link_id IS NOT NULL;
