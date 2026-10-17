-- Contract exit workflow, part 2: settlement, admin approval and refund payment.
--
-- A settlement is the contract's final deposit position at exit: the deposit it
-- holds, less the inspection charges, leaving either a REFUND due to the
-- customer or an amount the customer OWES. It is cleared by staff, approved by
-- an admin, and (for refunds) paid by accounts as a manual bank transfer.
--
-- Nothing here contacts the customer. Unpaid invoices and unbilled usage are
-- NOT netted here: they are settled through the existing billing flows first,
-- and clearing is refused until none remain.
--
-- Money rule: approval moves the deposit out of the customer's pool by adding
-- refund + retained charges to contracts.deposit_refunded_amount, the lever
-- the pooled-deposit functions (00502) already subtract. Those functions are
-- not changed.
--
-- Rollback: DROP FUNCTION approve_exit_settlement(UUID, UUID);
--           DROP TABLE exit_settlements;
-- (If any settlement was approved, first subtract its refund + retained
--  amounts back out of contracts.deposit_refunded_amount.)

CREATE TABLE IF NOT EXISTS exit_settlements (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exit_id               UUID NOT NULL REFERENCES contract_exits(id) ON DELETE CASCADE,
  contract_id           UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  lead_id               UUID NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  status                TEXT NOT NULL DEFAULT 'pending_approval'
                          CHECK (status IN ('pending_approval', 'returned', 'approved', 'paid', 'closed')),
  outcome               TEXT NOT NULL CHECK (outcome IN ('refund', 'owed', 'nil')),

  deposit_amount        NUMERIC(12,2) NOT NULL CHECK (deposit_amount >= 0),   -- the exit's own deposit at clearance
  charges_total         NUMERIC(12,2) NOT NULL CHECK (charges_total >= 0),
  retained_amount       NUMERIC(12,2) NOT NULL CHECK (retained_amount >= 0), -- charges covered by the deposit
  refund_amount         NUMERIC(12,2) NOT NULL CHECK (refund_amount >= 0),
  owed_amount           NUMERIC(12,2) NOT NULL CHECK (owed_amount >= 0),     -- charges the deposit could not cover
  CHECK (retained_amount + refund_amount <= deposit_amount),
  CHECK (retained_amount + owed_amount = charges_total),
  snapshot              JSONB NOT NULL DEFAULT '{}'::jsonb,                   -- charges as they stood when cleared

  bank_account_name     TEXT,
  bank_account_number   TEXT,
  bank_ifsc             TEXT,

  cleared_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  cleared_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TIMESTAMPTZ,
  returned_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  returned_at           TIMESTAMPTZ,
  return_reason         TEXT,

  -- refund payment (manual bank transfer, recorded by accounts)
  paid_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  paid_at               TIMESTAMPTZ,
  payment_date          DATE,
  payment_reference     TEXT,        -- bank UTR
  paid_from_account     TEXT,
  payment_notes         TEXT,

  -- owed: accounts raises the invoice by hand through normal billing
  owed_invoice_reference TEXT,
  owed_handled_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  owed_handled_at        TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live settlement per exit; a returned one is history and does not block a new clearance.
CREATE UNIQUE INDEX IF NOT EXISTS uq_exit_settlements_one_live
  ON exit_settlements (exit_id) WHERE status IN ('pending_approval', 'approved', 'paid', 'closed');
CREATE INDEX IF NOT EXISTS idx_exit_settlements_status ON exit_settlements (status);
CREATE INDEX IF NOT EXISTS idx_exit_settlements_contract ON exit_settlements (contract_id);

ALTER TABLE exit_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "exit_settlements_select" ON exit_settlements FOR SELECT TO authenticated USING (true);
GRANT SELECT ON exit_settlements TO authenticated;
GRANT ALL ON exit_settlements TO service_role;

-- ── approve_exit_settlement ─────────────────────────────────────────────────
-- Admin approval, atomic with the deposit movement. Takes the same advisory
-- lock as request_deposit_adjustment so it cannot race a deposit adjustment on
-- the same customer's pool.
CREATE OR REPLACE FUNCTION approve_exit_settlement(
  p_settlement_id UUID,
  p_approved_by   UUID
)
RETURNS TABLE(success BOOLEAN, error TEXT, new_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_s            exit_settlements%ROWTYPE;
  v_role         TEXT;
  v_need         NUMERIC;
  v_own          NUMERIC;
  v_pool         NUMERIC;
  v_status       TEXT;
BEGIN
  SELECT * INTO v_s FROM exit_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF v_s.id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Settlement not found', NULL::TEXT; RETURN;
  END IF;
  IF v_s.status <> 'pending_approval' THEN
    RETURN QUERY SELECT FALSE, format('Settlement is not awaiting approval (status: %s)', v_s.status), NULL::TEXT; RETURN;
  END IF;

  SELECT role INTO v_role FROM users WHERE id = p_approved_by;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN QUERY SELECT FALSE, 'Only an admin can approve an exit settlement', NULL::TEXT; RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('deposit_pool:' || v_s.lead_id::text));

  v_need := v_s.refund_amount + v_s.retained_amount;

  SELECT GREATEST(
    (CASE WHEN c.deposit_payment_status = 'paid'
       THEN COALESCE(c.deposit_payment_amount, c.security_deposit_amount, 0) ELSE 0 END)
    - COALESCE(c.deposit_refunded_amount, 0), 0)
  INTO v_own FROM contracts c WHERE c.id = v_s.contract_id;

  IF v_need > COALESCE(v_own, 0) + 0.01 THEN
    RETURN QUERY SELECT FALSE,
      format('The contract''s deposit has changed since this was cleared (holds %s, needs %s). Return it for changes.', ROUND(COALESCE(v_own,0),2), ROUND(v_need,2)),
      NULL::TEXT;
    RETURN;
  END IF;

  SELECT available INTO v_pool FROM get_deposit_available_balance(v_s.contract_id);
  IF v_need > COALESCE(v_pool, 0) + 0.01 THEN
    RETURN QUERY SELECT FALSE,
      format('The customer''s deposit pool no longer covers this (available %s, needs %s). Return it for changes.', ROUND(COALESCE(v_pool,0),2), ROUND(v_need,2)),
      NULL::TEXT;
    RETURN;
  END IF;

  -- Move the deposit out of the pool.
  IF v_need > 0 THEN
    UPDATE contracts SET
      deposit_refunded_amount  = COALESCE(deposit_refunded_amount, 0) + v_need,
      deposit_refunded_at      = NOW(),
      deposit_refund_reference = 'EXIT-' || substr(v_s.id::text, 1, 8)
    WHERE id = v_s.contract_id;
  END IF;

  v_status := CASE WHEN v_s.refund_amount > 0 THEN 'approved' ELSE 'closed' END;
  UPDATE exit_settlements SET
    status = v_status, approved_by = p_approved_by, approved_at = NOW(), updated_at = NOW()
  WHERE id = p_settlement_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_status;
END;
$$;

REVOKE ALL ON FUNCTION approve_exit_settlement(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approve_exit_settlement(UUID, UUID) TO service_role;
