-- Migration 00038: Prepaid Package Enhancements
-- Gap 1: Space-specific packages
-- Gap 2: Payment lifecycle for purchases

-- Gap 1: Allow a package to be bound to a specific space (more precise than workspace_type)
ALTER TABLE prepaid_packages
  ADD COLUMN IF NOT EXISTS space_id UUID REFERENCES spaces(id) ON DELETE SET NULL;

-- Gap 2: Payment lifecycle — package only usable after payment confirmed
ALTER TABLE prepaid_purchases
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'paid'
    CHECK (payment_status IN ('pending_payment', 'paid')),
  ADD COLUMN IF NOT EXISTS razorpay_payment_link_id TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_payment_link_url TEXT;

-- Index for filtering active/usable purchases by payment status
CREATE INDEX IF NOT EXISTS idx_prepaid_purchases_payment_status
  ON prepaid_purchases(payment_status);
