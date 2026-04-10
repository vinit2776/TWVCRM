-- Waiver request table for manager-OTP approved waivers (late checkout, extension charges)
CREATE TABLE IF NOT EXISTS waiver_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  requester_id    UUID NOT NULL REFERENCES users(id),
  waiver_type     TEXT NOT NULL CHECK (waiver_type IN ('overtime', 'extension', 'other')),
  waiver_amount   DECIMAL(12,2) NOT NULL DEFAULT 0,
  note            TEXT,
  otp             TEXT NOT NULL,
  otp_expires_at  TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS waiver_requests_booking_id_idx ON waiver_requests(booking_id);
CREATE INDEX IF NOT EXISTS waiver_requests_status_idx ON waiver_requests(status);
