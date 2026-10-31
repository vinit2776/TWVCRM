-- A booking's collected money may sit over its total by the same tolerance the
-- app treats as "settled": ₹10 or 2% of the total, whichever is higher
-- (bookingPaymentTolerance in src/lib/booking-payment-rules.ts).
--
-- Same body as 00640's insert_booking_payment_atomic; the only change is that
-- the over-balance check allows that tolerance instead of 1 paisa, so a counter
-- payment that rounds a few rupees past the last balance is not refused.
-- Rollback: re-apply the function from 00640.

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
  v_tolerance NUMERIC;
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
  -- Razorpay pending rows are excluded on purpose (see 00640).
  SELECT COALESCE(SUM(bp.amount), 0) INTO v_pending_upi
  FROM booking_payments bp
  WHERE bp.booking_id = p_booking_id
    AND bp.status = 'pending'
    AND bp.payment_mode = 'upi';

  v_grand_total := COALESCE(v_booking.total_amount_with_gst, v_booking.total_amount);
  v_balance_due := v_grand_total - v_paid_so_far - v_pending_upi;
  v_tolerance := GREATEST(10, ROUND(v_grand_total * 2) / 100);

  IF p_amount > v_balance_due + v_tolerance THEN
    IF v_pending_upi > 0 THEN
      IF v_balance_due <= v_tolerance THEN
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
