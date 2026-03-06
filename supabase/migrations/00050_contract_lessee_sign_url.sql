-- Add separate column to store the lessee (customer) signing URL from Leegality
-- The existing leegality_sign_url stores the lessor (TWV/Naval) signing URL
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS leegality_lessee_sign_url TEXT;
