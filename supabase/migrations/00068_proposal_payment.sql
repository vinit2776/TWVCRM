-- Add payment tracking fields to proposals for Razorpay payment link integration
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS razorpay_payment_link_id TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_payment_link_url TEXT,
  ADD COLUMN IF NOT EXISTS payment_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_amount DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS payment_reference TEXT;
