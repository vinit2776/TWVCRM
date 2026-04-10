-- Per-manager unique OTPs for waiver requests
-- Each manager/admin gets their own OTP so we can track who approved

CREATE TABLE IF NOT EXISTS waiver_request_otps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  waiver_request_id UUID NOT NULL REFERENCES waiver_requests(id) ON DELETE CASCADE,
  manager_id        UUID NOT NULL REFERENCES users(id),
  otp               TEXT NOT NULL,
  used              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS waiver_request_otps_waiver_idx ON waiver_request_otps(waiver_request_id);
CREATE INDEX IF NOT EXISTS waiver_request_otps_otp_idx    ON waiver_request_otps(otp);

-- Drop the single shared OTP column from waiver_requests (now per-manager)
ALTER TABLE waiver_requests DROP COLUMN IF EXISTS otp;
