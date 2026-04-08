-- Usage charge proof upload and settlement tracking
ALTER TABLE usage_charges
  ADD COLUMN IF NOT EXISTS proof_path TEXT,
  ADD COLUMN IF NOT EXISTS settled_in_booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS waived_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS waived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS waive_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_charges_settled_booking ON usage_charges(settled_in_booking_id) WHERE settled_in_booking_id IS NOT NULL;
