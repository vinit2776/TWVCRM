-- ============================================================
-- Migration 00133: Cancellation flow — reasons, lead cautions, refund requests
-- ============================================================
-- Replaces the old "click Cancel → state flip" with a richer flow:
--   - Cancellation reason (picklist) + optional details
--   - Optional caution attached to the lead, surfaced on profile +
--     new-booking flow (helps catch fake/repeat-no-show patterns)
--   - When payment was collected and cancellation qualifies for
--     refund, a refund_request is queued for manager/admin approval
--     before finance processes it
--   - When payment is retained, the booking is flagged for finance
--     to issue a GST invoice for the kept amount
--
-- Locked policy (signed off with product owner):
--   - Both no-payment and paid cancellations can attach a caution
--   - Cautions surface on lead profile AND new-booking flow
--   - Refund eligibility goes through manager/admin approval
--   - GST invoice issuance is finance's manual step (we just flag)
--   - No "uncancel" — once cancelled, it's terminal
-- ============================================================

-- ── 1. Bookings: cancellation columns ────────────────────────────────
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancellation_reason  TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_details TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gst_invoice_required BOOLEAN DEFAULT FALSE;

-- Partial index: finance dashboard query "show me cancelled bookings
-- with retained payment that need GST invoice issued."
CREATE INDEX IF NOT EXISTS idx_bookings_gst_invoice_required
  ON bookings(updated_at DESC)
  WHERE status = 'cancelled' AND gst_invoice_required = TRUE;

-- ── 2. Lead cautions table ───────────────────────────────────────────
-- Warnings/notes attached to a lead, surfaced as banners on the lead
-- profile and at the top of the new-booking flow when the customer's
-- phone is searched. Three severity levels — danger requires explicit
-- acknowledgement before staff can proceed with a new booking.

CREATE TYPE lead_caution_severity AS ENUM ('info', 'warning', 'danger');

CREATE TABLE lead_cautions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- Optional link back to the booking that triggered the caution.
  -- NULL when staff adds a caution manually from the lead profile.
  booking_id  UUID REFERENCES bookings(id) ON DELETE SET NULL,
  note        TEXT NOT NULL,
  severity    lead_caution_severity NOT NULL DEFAULT 'warning',
  -- Soft-dismiss: cautions go inactive but stay in audit. Active
  -- cautions surface on UI; inactive ones live in "history".
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  dismissed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  dismissed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary lookup: "active cautions for this lead, ordered by severity"
CREATE INDEX idx_lead_cautions_lead_active
  ON lead_cautions(lead_id, severity, created_at DESC)
  WHERE is_active = TRUE;

-- Audit/history trail across all leads
CREATE INDEX idx_lead_cautions_lead_id ON lead_cautions(lead_id);
CREATE INDEX idx_lead_cautions_booking_id ON lead_cautions(booking_id) WHERE booking_id IS NOT NULL;

CREATE TRIGGER update_lead_cautions_updated_at
  BEFORE UPDATE ON lead_cautions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE lead_cautions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read lead_cautions"
  ON lead_cautions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert lead_cautions"
  ON lead_cautions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update lead_cautions"
  ON lead_cautions FOR UPDATE TO authenticated USING (true);

-- ── 3. Refund requests table ─────────────────────────────────────────
-- Two-stage workflow: staff submits a request → manager/admin approves
-- (or rejects) → finance processes (or rolls forward as approved). The
-- payment record stays immutable; the refund_request points at the
-- booking it relates to.

CREATE TYPE refund_request_status AS ENUM (
  'pending_approval',  -- staff submitted, awaiting manager/admin decision
  'approved',          -- approved, awaiting finance to actually issue refund
  'rejected',          -- denied by manager/admin; payment stays
  'processed'          -- finance has issued the refund
);

CREATE TABLE refund_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  amount_requested  NUMERIC(12, 2) NOT NULL CHECK (amount_requested > 0),

  reason            TEXT NOT NULL,    -- picklist value (centre_at_fault | within_policy_window | goodwill | other)
  details           TEXT,             -- optional free-text

  status            refund_request_status NOT NULL DEFAULT 'pending_approval',

  requested_by      UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Manager / admin approval leg
  approved_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at       TIMESTAMPTZ,
  rejected_reason   TEXT,

  -- Finance processing leg (filled when refund is actually issued)
  processed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  processed_at      TIMESTAMPTZ,
  refund_method     TEXT,             -- bank_transfer | cash | gateway | other
  refund_reference  TEXT,             -- transaction ID / NEFT ref / cash voucher

  notes             TEXT,             -- optional finance notes

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Finance dashboard queries
CREATE INDEX idx_refund_requests_status
  ON refund_requests(status, requested_at DESC);
CREATE INDEX idx_refund_requests_booking_id
  ON refund_requests(booking_id);

CREATE TRIGGER update_refund_requests_updated_at
  BEFORE UPDATE ON refund_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE refund_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read refund_requests"
  ON refund_requests FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert refund_requests"
  ON refund_requests FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated update refund_requests"
  ON refund_requests FOR UPDATE TO authenticated USING (true);
