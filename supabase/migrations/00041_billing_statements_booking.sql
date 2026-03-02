-- Allow billing statements to be linked to a booking (not just a contract).
-- This supports generating statements for one-time space bookings where
-- there is no active membership contract.

-- 1. Make contract_id nullable (booking-based statements won't have one)
ALTER TABLE billing_statements
  ALTER COLUMN contract_id DROP NOT NULL;

-- 2. Make lead_id nullable (walk-in bookings may not have an associated lead)
ALTER TABLE billing_statements
  ALTER COLUMN lead_id DROP NOT NULL;

-- 3. Add booking_id FK
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL;

-- 4. Ensure at least one of contract or booking is always set
ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_source_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_source_check
  CHECK (contract_id IS NOT NULL OR booking_id IS NOT NULL);

-- 5. Index for quick lookup by booking
CREATE INDEX IF NOT EXISTS idx_billing_statements_booking_id
  ON billing_statements(booking_id)
  WHERE booking_id IS NOT NULL;
