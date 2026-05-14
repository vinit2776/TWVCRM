-- Deposit Waiver OTP: when security_deposit_months = 0, require admin OTP
-- approval before the proposal can be sent or downloaded.

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_waiver_otp         TEXT,
  ADD COLUMN IF NOT EXISTS deposit_waiver_otp_expires  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_waiver_verified_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_waiver_verified_by  UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS deposit_waiver_requested_at TIMESTAMPTZ;
