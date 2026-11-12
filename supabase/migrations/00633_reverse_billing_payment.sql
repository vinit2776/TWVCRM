-- ============================================================
-- Migration 00633: Admin reversal of a customer payment recorded in error
--
-- A payment recorded on a customer statement (billing_payments) was permanent:
-- no route could undo one, and voiding a statement is refused while any payment
-- exists. When accounts recorded a bank receipt that never arrived, the only
-- fix was hand-edited SQL in production (TWV-BS-0526, 2026-10-21).
--
-- reverse_billing_payment() does that fix atomically, under a lock on the
-- statement:
--   * refuses anything that has left the books or touched real money
--     (gateway payment, Tally receipt, TDS deposited, deposit adjustment,
--     accounted / period-locked / voided / written-off statement, or a
--     statement tied to a proposal, ad-hoc invoice or VO case, whose payment
--     also moved those records);
--   * copies the full payment row into billing_payment_reversals, then deletes
--     it (customer readers sum billing_payments directly, so a soft-delete flag
--     would need every reader changed — the deposit-adjustment reversal already
--     deletes the same way);
--   * recomputes payment_status with the same whole-rupee rule as
--     src/lib/settlement.ts;
--   * when the statement leaves "paid", puts handoff_state back to what it held
--     before the payment moved it (read from audit_trail), so the statement
--     leaves the Tally Inbox "GST to issue" / "Payments to record" queues.
--
-- Service role only: the API route checks the caller is an admin first.
--
-- Rollback: DROP FUNCTION reverse_billing_payment(UUID, UUID, UUID, TEXT);
--           DROP TABLE billing_payment_reversals;
-- ============================================================

CREATE TABLE IF NOT EXISTS billing_payment_reversals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_statement_id  UUID NOT NULL REFERENCES billing_statements(id),
  payment_snapshot      JSONB NOT NULL,          -- the full billing_payments row as it was
  reason                TEXT NOT NULL,
  reversed_by           UUID REFERENCES users(id),
  reversed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_payment_status TEXT,
  new_payment_status      TEXT,
  previous_handoff_state  TEXT,
  new_handoff_state       TEXT
);

CREATE INDEX IF NOT EXISTS idx_billing_payment_reversals_statement
  ON billing_payment_reversals(billing_statement_id);

ALTER TABLE billing_payment_reversals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read billing_payment_reversals" ON billing_payment_reversals;
CREATE POLICY "Authenticated users can read billing_payment_reversals"
  ON billing_payment_reversals FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION reverse_billing_payment(
  p_statement_id UUID,
  p_payment_id   UUID,
  p_actor        UUID,
  p_reason       TEXT
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_stmt        billing_statements%ROWTYPE;
  v_pay         billing_payments%ROWTYPE;
  v_pj          JSONB;
  v_period_status TEXT;
  v_remaining   NUMERIC;
  v_settle      NUMERIC;
  v_new_status  TEXT;
  v_new_handoff TEXT;
  v_prior       TEXT;
  v_prior_found BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_stmt FROM billing_statements WHERE id = p_statement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STATEMENT_NOT_FOUND'; END IF;

  SELECT * INTO v_pay FROM billing_payments
   WHERE id = p_payment_id AND billing_statement_id = p_statement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;
  -- Optional columns (TDS, Tally receipt) are read via JSON so this works on any
  -- schema, including environments that haven't taken every billing_payments column.
  v_pj := to_jsonb(v_pay);

  -- Real money or a record outside this statement: not a "recorded in error" fix.
  IF v_pj->>'razorpay_payment_id' IS NOT NULL OR v_pj->>'payment_mode' = 'razorpay' THEN
    RAISE EXCEPTION 'GATEWAY_PAYMENT';
  END IF;
  IF v_pj->>'tally_receipt_number' IS NOT NULL OR v_pj->>'tally_receipt_voucher_guid' IS NOT NULL THEN
    RAISE EXCEPTION 'TALLY_RECEIPT_RECORDED';
  END IF;
  IF v_pj->>'tds_quarter' IS NOT NULL OR v_pj->>'tds_fy_year' IS NOT NULL OR v_pj->>'tds_certificate_path' IS NOT NULL THEN
    RAISE EXCEPTION 'TDS_RECORDED';
  END IF;
  IF EXISTS (SELECT 1 FROM deposit_adjustments WHERE billing_payment_id = p_payment_id) THEN
    RAISE EXCEPTION 'DEPOSIT_ADJUSTMENT_PAYMENT';
  END IF;

  IF v_stmt.status IN ('voided', 'discarded') OR v_stmt.written_off_at IS NOT NULL THEN
    RAISE EXCEPTION 'STATEMENT_CLOSED';
  END IF;
  IF v_stmt.accounted THEN RAISE EXCEPTION 'STATEMENT_ACCOUNTED'; END IF;
  IF v_stmt.accounting_period_id IS NOT NULL THEN
    SELECT status INTO v_period_status FROM accounting_periods WHERE id = v_stmt.accounting_period_id;
    IF v_period_status = 'locked' THEN RAISE EXCEPTION 'PERIOD_LOCKED'; END IF;
  END IF;
  -- Their own payment also moved the proposal / ad-hoc invoice / VO case.
  IF v_stmt.proposal_id IS NOT NULL OR v_stmt.invoice_id IS NOT NULL
     OR v_stmt.case_id IS NOT NULL OR v_stmt.aggregator_id IS NOT NULL THEN
    RAISE EXCEPTION 'LINKED_DOCUMENT';
  END IF;

  -- What the statement settles to once this payment is gone (same rule as settlement.ts).
  SELECT COALESCE(SUM(amount + COALESCE(tds_amount, 0)), 0) INTO v_remaining
    FROM billing_payments
   WHERE billing_statement_id = p_statement_id AND id <> p_payment_id;
  v_settle := ROUND(COALESCE(v_stmt.total_amount, 0));
  v_new_status := CASE
    WHEN v_remaining >= v_settle THEN 'paid'
    WHEN v_remaining > 0 THEN 'partially_paid'
    ELSE 'unpaid' END;

  -- Only when the statement leaves "paid" did the payment's own handoff move apply.
  v_new_handoff := v_stmt.handoff_state;
  IF v_stmt.payment_status = 'paid' AND v_new_status <> 'paid' THEN
    SELECT (a.changes->'handoff_state'->>'old') INTO v_prior
      FROM audit_trail a
     WHERE a.entity_type = 'billing_statement' AND a.entity_id = p_statement_id
       AND a.changes->'handoff_state'->>'new' = v_stmt.handoff_state
     ORDER BY a.created_at DESC LIMIT 1;
    v_prior_found := FOUND;  -- INTO with no row nulls the targets, so FOUND is the reliable signal

    IF v_stmt.handoff_state = 'pi_paid_awaiting_gst' THEN
      v_new_handoff := CASE WHEN v_prior_found THEN v_prior ELSE NULL END;
    ELSIF v_stmt.handoff_state = 'paid_awaiting_receipt_record' THEN
      v_new_handoff := CASE WHEN v_prior_found THEN v_prior ELSE 'direct_gst_requested' END;
    ELSIF v_stmt.handoff_state = 'complete' THEN
      -- Closed by this payment only if it moved gst_sent_awaiting_payment -> complete.
      IF v_prior_found AND v_prior = 'gst_sent_awaiting_payment' THEN
        v_new_handoff := 'gst_sent_awaiting_payment';
      ELSE
        RAISE EXCEPTION 'HANDOFF_CLOSED';
      END IF;
    END IF;
  END IF;

  INSERT INTO billing_payment_reversals (
    billing_statement_id, payment_snapshot, reason, reversed_by,
    previous_payment_status, new_payment_status, previous_handoff_state, new_handoff_state
  ) VALUES (
    p_statement_id, v_pj, p_reason, p_actor,
    v_stmt.payment_status, v_new_status, v_stmt.handoff_state, v_new_handoff
  );

  DELETE FROM billing_payments WHERE id = p_payment_id;

  UPDATE billing_statements
     SET payment_status = v_new_status,
         handoff_state  = v_new_handoff
   WHERE id = p_statement_id;

  RETURN jsonb_build_object(
    'payment_status', v_new_status,
    'handoff_state',  v_new_handoff,
    'total_paid',     v_remaining,
    'balance_due',    GREATEST(0, v_settle - v_remaining),
    'previous', jsonb_build_object(
      'payment_status', v_stmt.payment_status,
      'handoff_state',  v_stmt.handoff_state
    ),
    'payment', v_pj
  );
END;
$$;

REVOKE ALL ON FUNCTION reverse_billing_payment(UUID, UUID, UUID, TEXT) FROM PUBLIC;
