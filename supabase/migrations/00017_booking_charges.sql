-- Allow usage charges to be linked to a booking (not just a contract)
-- This supports logging post-visit charges for walk-in/guest customers
-- who may not have an active membership contract.

-- 1. Make contract_id nullable (was NOT NULL)
ALTER TABLE usage_charges
  ALTER COLUMN contract_id DROP NOT NULL;

-- 2. Add booking_id column
ALTER TABLE usage_charges
  ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL;

-- 3. Ensure at least one of contract_id / booking_id is always set
ALTER TABLE usage_charges
  ADD CONSTRAINT usage_charges_source_check
  CHECK (contract_id IS NOT NULL OR booking_id IS NOT NULL);

-- 4. Index for quick lookup of charges by booking
CREATE INDEX IF NOT EXISTS idx_usage_charges_booking_id
  ON usage_charges(booking_id)
  WHERE booking_id IS NOT NULL;
