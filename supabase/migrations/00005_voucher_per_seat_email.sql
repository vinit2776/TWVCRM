-- ==========================================
-- Voucher Per-Seat Email & Replacement System
-- ==========================================

-- 1. Drop blocking UNIQUE constraint that prevents replacement vouchers per seat
ALTER TABLE voucher_issuances
  DROP CONSTRAINT IF EXISTS voucher_issuances_contract_id_seat_number_key;

-- 2. Add per-seat tracking columns
ALTER TABLE voucher_issuances
  ADD COLUMN IF NOT EXISTS seat_occupant_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS replaces_issuance_id UUID REFERENCES voucher_issuances(id) ON DELETE SET NULL;

-- 3. Partial unique index: only one ACTIVE voucher per seat per contract
-- This ensures data integrity while allowing replacement history
CREATE UNIQUE INDEX IF NOT EXISTS idx_voucher_issuances_active_seat
  ON voucher_issuances(contract_id, seat_number)
  WHERE is_active = true;

-- 4. Index for quick active lookups
CREATE INDEX IF NOT EXISTS idx_voucher_issuances_active
  ON voucher_issuances(contract_id, is_active)
  WHERE is_active = true;

-- 5. OTP table for replacement authorization
CREATE TABLE IF NOT EXISTS admin_otp (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  otp_code VARCHAR(6) NOT NULL,
  purpose VARCHAR(50) NOT NULL DEFAULT 'voucher_replacement',
  reference_id UUID NOT NULL,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  is_used BOOLEAN DEFAULT false,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS for admin_otp
ALTER TABLE admin_otp ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage admin_otp"
  ON admin_otp FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Index for OTP lookup
CREATE INDEX IF NOT EXISTS idx_admin_otp_lookup
  ON admin_otp(otp_code, is_used, expires_at);

CREATE INDEX IF NOT EXISTS idx_admin_otp_reference
  ON admin_otp(reference_id);
