-- Security deposit fields on proposals
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS security_deposit_months INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS security_deposit_amount DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_payment_status TEXT DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS deposit_razorpay_link_id TEXT,
  ADD COLUMN IF NOT EXISTS deposit_razorpay_link_url TEXT,
  ADD COLUMN IF NOT EXISTS deposit_payment_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_payment_amount DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS deposit_payment_reference TEXT;
