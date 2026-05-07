-- ============================================================
-- Migration 00129: Booking credit ledger ("partial-checkout carry-forward")
-- ============================================================
-- Lets a customer who checks in but leaves before their booked end-time
-- carry the unused whole hours forward as a credit, redeemable on a
-- future booking at the SAME centre, within 30 days of issue.
--
-- Design contract (locked with product owner):
--   • Phone is the anchor — survives lead/contract churn, works for
--     walk-ins. lead_id is populated when known but not required.
--   • Centre-bound — credits issued at MG Road can only be redeemed at
--     MG Road. (Future: cross-centre toggle without schema change.)
--   • Whole hours only. Fractional time is forfeited at issue.
--   • Hourly rate snapshot — protects the customer from rate changes
--     between issue and redemption. Stored in rupees per hour.
--   • Floor manager+ can override defaults (rounding, expiry).
--   • Source-booking cancel/refund leaves the credit alone (clean
--     separation between refund-flow and credit-flow audit trails).
-- ============================================================

CREATE TYPE booking_credit_status AS ENUM ('active', 'exhausted', 'expired', 'revoked');

CREATE TABLE booking_credits (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Anchor: phone is the truth for walk-ins (no lead row), and even for
  -- contract members it survives email/lead changes. Stored without
  -- formatting; the booking-search side normalises before lookup.
  phone                    TEXT         NOT NULL,
  location_id              UUID         NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  lead_id                  UUID         REFERENCES leads(id) ON DELETE SET NULL,

  -- Whole-hour credit (the type allows fractional in case the policy
  -- ever loosens — today the API + UI both floor to integers).
  hours_total              NUMERIC(4, 1) NOT NULL CHECK (hours_total > 0),
  hours_used               NUMERIC(4, 1) NOT NULL DEFAULT 0  CHECK (hours_used >= 0),

  -- Snapshot of the rate at issue time. Locked, NOT recalculated on
  -- redemption — the customer was promised "2 hours" worth of access at
  -- today's rate, and that's what they get even if the rate changes.
  hourly_rate_snapshot     NUMERIC(10, 2) NOT NULL,

  issued_from_booking_id   UUID         REFERENCES bookings(id) ON DELETE SET NULL,
  issued_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ  NOT NULL,

  status                   booking_credit_status NOT NULL DEFAULT 'active',
  notes                    TEXT,

  issued_by                UUID         REFERENCES users(id) ON DELETE SET NULL,
  revoked_by               UUID         REFERENCES users(id) ON DELETE SET NULL,
  revoked_at               TIMESTAMPTZ,

  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Defensive — can't use more than was issued.
  CONSTRAINT booking_credits_used_within_total CHECK (hours_used <= hours_total)
);

-- Primary lookup: "show me active credits for this phone at this centre"
CREATE INDEX idx_booking_credits_phone_loc_active
  ON booking_credits(phone, location_id, status, expires_at)
  WHERE status = 'active';

-- Secondary lookups — lead profile card + audit trail back to source booking
CREATE INDEX idx_booking_credits_lead_id ON booking_credits(lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX idx_booking_credits_source ON booking_credits(issued_from_booking_id) WHERE issued_from_booking_id IS NOT NULL;

-- Auto-update updated_at (reuse the existing trigger function)
CREATE TRIGGER update_booking_credits_updated_at
  BEFORE UPDATE ON booking_credits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS — same permissive shape as bookings/usage_charges (auth-only;
-- role-level gating happens in the API layer).
ALTER TABLE booking_credits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read booking_credits"
  ON booking_credits FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert booking_credits"
  ON booking_credits FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update booking_credits"
  ON booking_credits FOR UPDATE TO authenticated USING (true);

-- Backlink on bookings: which credit (if any) covered this booking. NULL
-- for bookings paid normally; populated when the credit was applied at
-- booking-creation time.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS credit_redeemed_id UUID REFERENCES booking_credits(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_credit_redeemed_id
  ON bookings(credit_redeemed_id) WHERE credit_redeemed_id IS NOT NULL;
