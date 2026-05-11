-- Fix 9: Atomic RPCs for prepaid redemption and booking payment insertion
--
-- Prevents race conditions where concurrent requests both read stale values
-- and then write, causing double-spend or overpayment.

-- 1. redeem_prepaid_credits
--    Atomically increments credits_used on a prepaid_purchase and inserts
--    the redemption record. Returns FALSE if insufficient credits remain.
--    Uses FOR UPDATE to lock the row during the transaction.

CREATE OR REPLACE FUNCTION redeem_prepaid_credits(
  p_purchase_id UUID,
  p_booking_id UUID,
  p_credits_to_deduct NUMERIC,
  p_redeemed_by UUID
)
RETURNS TABLE(
  success BOOLEAN,
  new_credits_used NUMERIC,
  new_status TEXT,
  redemption_id UUID
) LANGUAGE plpgsql AS $$
DECLARE
  v_purchase RECORD;
  v_new_credits_used NUMERIC;
  v_is_exhausted BOOLEAN;
  v_new_status TEXT;
  v_redemption_id UUID;
BEGIN
  -- Lock the purchase row to prevent concurrent modifications
  SELECT pp.credits_used, pp.total_credits, pp.status
  INTO v_purchase
  FROM prepaid_purchases pp
  WHERE pp.id = p_purchase_id
  FOR UPDATE;

  IF v_purchase IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- Check sufficient credits remain
  v_new_credits_used := ROUND(v_purchase.credits_used + p_credits_to_deduct, 2);
  IF v_new_credits_used > v_purchase.total_credits THEN
    RETURN QUERY SELECT FALSE, v_purchase.credits_used, v_purchase.status, NULL::UUID;
    RETURN;
  END IF;

  -- Determine new status
  v_is_exhausted := v_new_credits_used >= v_purchase.total_credits;
  v_new_status := CASE WHEN v_is_exhausted THEN 'exhausted' ELSE v_purchase.status END;

  -- Update purchase
  UPDATE prepaid_purchases SET
    credits_used = v_new_credits_used,
    status = v_new_status,
    updated_at = NOW()
  WHERE id = p_purchase_id;

  -- Insert redemption record
  INSERT INTO prepaid_redemptions (
    purchase_id, booking_id, credits_deducted, redeemed_by
  ) VALUES (
    p_purchase_id, p_booking_id, p_credits_to_deduct, p_redeemed_by
  ) RETURNING id INTO v_redemption_id;

  RETURN QUERY SELECT TRUE, v_new_credits_used, v_new_status, v_redemption_id;
END;
$$;


-- 2. insert_booking_payment_atomic
--    Atomically checks the balance due on a booking and inserts a payment
--    only if the amount does not exceed the remaining balance. Prevents the
--    race where two concurrent payment submissions both read the same
--    paidSoFar value and both pass the balance check.

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
  v_grand_total NUMERIC;
  v_balance_due NUMERIC;
  v_payment RECORD;
BEGIN
  -- Lock the booking row
  SELECT b.id, b.total_amount, b.total_amount_with_gst, b.payment_status
  INTO v_booking
  FROM bookings b
  WHERE b.id = p_booking_id
  FOR UPDATE;

  IF v_booking IS NULL THEN
    RETURN jsonb_build_object('error', 'Booking not found');
  END IF;

  -- Sum existing verified payments (within the lock)
  SELECT COALESCE(SUM(bp.amount), 0) INTO v_paid_so_far
  FROM booking_payments bp
  WHERE bp.booking_id = p_booking_id
    AND bp.status = 'verified';

  v_grand_total := COALESCE(v_booking.total_amount_with_gst, v_booking.total_amount);
  v_balance_due := v_grand_total - v_paid_so_far;

  -- Check balance (with small epsilon for floating point)
  IF p_amount > v_balance_due + 0.01 THEN
    RETURN jsonb_build_object(
      'error', format('Amount exceeds balance due. Balance: ₹%s', ROUND(v_balance_due, 2)),
      'balance_due', v_balance_due
    );
  END IF;

  -- Insert the payment
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
    'grand_total', v_grand_total,
    'new_total', v_paid_so_far + p_amount
  );
END;
$$;
