-- A booking payment staff report (manual UPI, awaiting accounts) now has a
-- verification thread, and can no longer be reported twice for the same money.
--
-- Before this, a UPI payment recorded by a role that can't self-verify sat as
-- booking_payments.status = 'pending' with nobody told: the Tally Inbox "To
-- verify" tab and the Queries tab both read `queries` threads of kind
-- payment_reported, and a booking payment never raised one. The walk-in also
-- couldn't check in, because the gate counted verified payments only.
--
-- 1. query_payment_reports learns a third target, 'booking', proved by the
--    booking_payments row it points at (same shape as the invoice case, which
--    is proved by billing_payment_id).
-- 2. insert_booking_payment_atomic now counts pending manual-UPI payments
--    against the balance, so two reports of the same ₹X can't both be taken.
--    Razorpay pending rows are NOT counted: staff create one when they send
--    a link, and it may never be paid.

ALTER TABLE query_payment_reports
  ADD COLUMN booking_payment_id UUID REFERENCES booking_payments(id) ON DELETE SET NULL;

ALTER TABLE query_payment_reports
  DROP CONSTRAINT IF EXISTS query_payment_reports_target_kind_check;
ALTER TABLE query_payment_reports
  ADD CONSTRAINT query_payment_reports_target_kind_check
  CHECK (target_kind IN ('invoice', 'deposit', 'booking'));

-- A booking report must point at the payment it is about from the day it is
-- raised (unlike an invoice report, whose payment only exists once accounts
-- record it), so verify has nothing to look up.
ALTER TABLE query_payment_reports
  ADD CONSTRAINT query_payment_reports_booking_has_payment CHECK (
    target_kind <> 'booking' OR booking_payment_id IS NOT NULL
  );

-- One report per payment: verifying from the booking page settles this one
-- report, and a second report can't claim the same row.
CREATE UNIQUE INDEX uq_qpr_booking_payment
  ON query_payment_reports (booking_payment_id)
  WHERE booking_payment_id IS NOT NULL;

COMMENT ON COLUMN query_payment_reports.booking_payment_id IS
  'For target_kind = booking: the booking_payments row awaiting verification. Verifying the report (or the payment from the booking page) settles both.';

-- ── Balance check counts pending manual UPI ────────────────────────────────
CREATE OR REPLACE FUNCTION insert_booking_payment_atomic(
  p_booking_id UUID,
  p_amount NUMERIC,
  p_payment_mode TEXT,
  p_payment_reference TEXT,
  p_status TEXT,
  p_created_by UUID,
  p_cash_handover_status TEXT DEFAULT NULL,
  p_collected_by UUID DEFAULT NULL,
  p_collected_at TIMESTAMPTZ DEFAULT NULL,
  p_screenshot_verified BOOLEAN DEFAULT NULL,
  p_verification_notes TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_booking RECORD;
  v_paid_so_far NUMERIC;
  v_pending_upi NUMERIC;
  v_grand_total NUMERIC;
  v_balance_due NUMERIC;
  v_payment RECORD;
BEGIN
  SELECT b.id, b.total_amount, b.total_amount_with_gst, b.payment_status
  INTO v_booking
  FROM bookings b
  WHERE b.id = p_booking_id
  FOR UPDATE;

  IF v_booking IS NULL THEN
    RETURN jsonb_build_object('error', 'Booking not found');
  END IF;

  SELECT COALESCE(SUM(bp.amount), 0) INTO v_paid_so_far
  FROM booking_payments bp
  WHERE bp.booking_id = p_booking_id
    AND bp.status = 'verified';

  -- Manual UPI reports awaiting accounts are real claims on the balance.
  -- Razorpay pending rows are excluded on purpose (see header).
  SELECT COALESCE(SUM(bp.amount), 0) INTO v_pending_upi
  FROM booking_payments bp
  WHERE bp.booking_id = p_booking_id
    AND bp.status = 'pending'
    AND bp.payment_mode = 'upi';

  v_grand_total := COALESCE(v_booking.total_amount_with_gst, v_booking.total_amount);
  v_balance_due := v_grand_total - v_paid_so_far - v_pending_upi;

  IF p_amount > v_balance_due + 0.01 THEN
    IF v_pending_upi > 0 THEN
      IF v_balance_due <= 0.01 THEN
        RETURN jsonb_build_object(
          'error', format(
            'The full amount is already reported: ₹%s is waiting for accounts to verify it. Ask accounts to check the bank before taking another payment.',
            to_char(v_pending_upi, 'FM999999990.00')
          ),
          'balance_due', v_balance_due,
          'pending_upi', v_pending_upi
        );
      END IF;
      RETURN jsonb_build_object(
        'error', format(
          'Only ₹%s is left to collect: ₹%s is already reported and waiting for accounts to verify it.',
          to_char(v_balance_due, 'FM999999990.00'), to_char(v_pending_upi, 'FM999999990.00')
        ),
        'balance_due', v_balance_due,
        'pending_upi', v_pending_upi
      );
    END IF;
    RETURN jsonb_build_object(
      'error', format('Amount exceeds balance due. Balance: ₹%s', ROUND(v_balance_due, 2)),
      'balance_due', v_balance_due
    );
  END IF;

  INSERT INTO booking_payments (
    booking_id, amount, payment_mode, payment_reference, status, created_by,
    cash_handover_status, collected_by, collected_at,
    screenshot_verified, verification_notes
  ) VALUES (
    p_booking_id, p_amount, p_payment_mode, p_payment_reference, p_status, p_created_by,
    p_cash_handover_status, p_collected_by, p_collected_at,
    p_screenshot_verified, p_verification_notes
  ) RETURNING * INTO v_payment;

  RETURN jsonb_build_object(
    'payment', to_jsonb(v_payment),
    'paid_so_far', v_paid_so_far,
    'pending_upi', v_pending_upi,
    'grand_total', v_grand_total,
    'new_total', v_paid_so_far + p_amount
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
