-- Staged security deposit, part 5: a customer walks away after paying some parts.
--
-- The money is refunded in full — no "retain". A manager / sales rep / admin
-- requests it from the proposal, an ADMIN approves every refund whatever the
-- amount, accounts pays it as a manual bank transfer (shown in Acc Payables),
-- and paying it closes the proposal as "Customer withdrew" (status 'rejected'
-- with that reason), so nothing can be asked of them again.
--
-- Only for a deposit that is still PARTLY paid and has no contract: a complete
-- deposit or an existing contract is the contract exit / settlement flow's job.
--
-- Rollback: DROP FUNCTION pay_deposit_refund(UUID,UUID,DATE,TEXT,TEXT,TEXT);
--           DROP FUNCTION reject_deposit_refund(UUID,UUID,TEXT);
--           DROP FUNCTION approve_deposit_refund(UUID,UUID);
--           DROP FUNCTION request_deposit_refund(UUID,UUID,TEXT,TEXT,TEXT,TEXT);
--           DROP TABLE proposal_deposit_refunds;
-- (If any refund was paid, reopen those proposals by hand first.)

CREATE TABLE IF NOT EXISTS proposal_deposit_refunds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id         UUID NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),   -- everything paid in parts, refunded whole
  status              TEXT NOT NULL DEFAULT 'pending_approval'
                        CHECK (status IN ('pending_approval', 'approved', 'rejected', 'paid')),
  reason              TEXT NOT NULL CHECK (length(btrim(reason)) >= 10),

  bank_account_name   TEXT,
  bank_account_number TEXT,
  bank_ifsc           TEXT,

  requested_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at         TIMESTAMPTZ,
  rejected_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  rejected_at         TIMESTAMPTZ,
  reject_reason       TEXT,

  paid_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  paid_at             TIMESTAMPTZ,
  payment_date        DATE,
  payment_reference   TEXT,       -- bank UTR
  paid_from_account   TEXT,
  payment_notes       TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live refund per proposal; a rejected one is history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_refund_one_live
  ON proposal_deposit_refunds (proposal_id) WHERE status IN ('pending_approval', 'approved', 'paid');
CREATE INDEX IF NOT EXISTS idx_deposit_refunds_status ON proposal_deposit_refunds (status);

ALTER TABLE proposal_deposit_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deposit_refunds_select" ON proposal_deposit_refunds FOR SELECT TO authenticated USING (true);
GRANT SELECT ON proposal_deposit_refunds TO authenticated;
GRANT ALL ON proposal_deposit_refunds TO service_role;

-- ── request ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION request_deposit_refund(
  p_proposal_id UUID, p_actor UUID, p_reason TEXT,
  p_bank_name TEXT, p_bank_number TEXT, p_bank_ifsc TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT; v_p proposals%ROWTYPE; v_paid NUMERIC; v_id UUID;
BEGIN
  SELECT role INTO v_role FROM users WHERE id = p_actor;
  IF v_role NOT IN ('admin', 'manager', 'sales_rep') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_allowed');
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_required');
  END IF;

  SELECT * INTO v_p FROM proposals WHERE id = p_proposal_id FOR UPDATE;
  IF v_p.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'proposal_not_found'); END IF;
  IF v_p.deposit_payment_status = 'paid' THEN RETURN jsonb_build_object('success', false, 'error', 'deposit_complete'); END IF;
  IF EXISTS (SELECT 1 FROM contracts WHERE proposal_id = p_proposal_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'contract_exists');
  END IF;
  IF EXISTS (SELECT 1 FROM proposal_deposit_instalments WHERE proposal_id = p_proposal_id AND status = 'requested') THEN
    RETURN jsonb_build_object('success', false, 'error', 'open_ask_exists');
  END IF;
  IF EXISTS (SELECT 1 FROM proposal_deposit_refunds WHERE proposal_id = p_proposal_id AND status IN ('pending_approval', 'approved', 'paid')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'refund_exists');
  END IF;

  SELECT COALESCE(SUM(COALESCE(paid_amount, amount)), 0) INTO v_paid
  FROM proposal_deposit_instalments WHERE proposal_id = p_proposal_id AND status = 'paid';
  IF v_paid <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'nothing_to_refund'); END IF;

  INSERT INTO proposal_deposit_refunds (proposal_id, amount, reason, bank_account_name, bank_account_number, bank_ifsc, requested_by)
  VALUES (p_proposal_id, v_paid, btrim(p_reason), NULLIF(btrim(p_bank_name), ''), NULLIF(btrim(p_bank_number), ''), NULLIF(btrim(p_bank_ifsc), ''), p_actor)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'refund_id', v_id, 'amount', v_paid);
END $$;

-- ── approve / reject (admin only, every refund) ─────────────────────────────
CREATE OR REPLACE FUNCTION approve_deposit_refund(p_refund_id UUID, p_actor UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r proposal_deposit_refunds%ROWTYPE;
BEGIN
  IF (SELECT role FROM users WHERE id = p_actor) IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_only');
  END IF;
  SELECT * INTO v_r FROM proposal_deposit_refunds WHERE id = p_refund_id FOR UPDATE;
  IF v_r.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'refund_not_found'); END IF;
  IF v_r.status <> 'pending_approval' THEN RETURN jsonb_build_object('success', false, 'error', 'not_pending'); END IF;
  UPDATE proposal_deposit_refunds SET status = 'approved', approved_by = p_actor, approved_at = NOW(), updated_at = NOW() WHERE id = p_refund_id;
  RETURN jsonb_build_object('success', true, 'proposal_id', v_r.proposal_id, 'amount', v_r.amount);
END $$;

CREATE OR REPLACE FUNCTION reject_deposit_refund(p_refund_id UUID, p_actor UUID, p_reason TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r proposal_deposit_refunds%ROWTYPE;
BEGIN
  IF (SELECT role FROM users WHERE id = p_actor) IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_only');
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN RETURN jsonb_build_object('success', false, 'error', 'reason_required'); END IF;
  SELECT * INTO v_r FROM proposal_deposit_refunds WHERE id = p_refund_id FOR UPDATE;
  IF v_r.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'refund_not_found'); END IF;
  IF v_r.status <> 'pending_approval' THEN RETURN jsonb_build_object('success', false, 'error', 'not_pending'); END IF;
  UPDATE proposal_deposit_refunds SET status = 'rejected', rejected_by = p_actor, rejected_at = NOW(), reject_reason = btrim(p_reason), updated_at = NOW() WHERE id = p_refund_id;
  RETURN jsonb_build_object('success', true, 'proposal_id', v_r.proposal_id);
END $$;

-- ── pay: records the bank transfer and closes the proposal ──────────────────
CREATE OR REPLACE FUNCTION pay_deposit_refund(
  p_refund_id UUID, p_actor UUID, p_payment_date DATE, p_reference TEXT, p_from_account TEXT, p_notes TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r proposal_deposit_refunds%ROWTYPE; v_p proposals%ROWTYPE;
BEGIN
  IF (SELECT role FROM users WHERE id = p_actor) NOT IN ('admin', 'accounts') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_allowed');
  END IF;
  IF p_reference IS NULL OR length(btrim(p_reference)) < 3 THEN RETURN jsonb_build_object('success', false, 'error', 'reference_required'); END IF;
  SELECT proposal_id INTO v_r.proposal_id FROM proposal_deposit_refunds WHERE id = p_refund_id;
  IF v_r.proposal_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'refund_not_found'); END IF;
  -- Proposal first, then the refund — same order as every other deposit function.
  SELECT * INTO v_p FROM proposals WHERE id = v_r.proposal_id FOR UPDATE;
  SELECT * INTO v_r FROM proposal_deposit_refunds WHERE id = p_refund_id FOR UPDATE;
  IF v_r.status <> 'approved' THEN RETURN jsonb_build_object('success', false, 'error', 'not_approved'); END IF;

  UPDATE proposal_deposit_refunds SET
    status = 'paid', paid_by = p_actor, paid_at = NOW(), payment_date = p_payment_date,
    payment_reference = btrim(p_reference), paid_from_account = btrim(p_from_account), payment_notes = NULLIF(btrim(p_notes), ''),
    updated_at = NOW()
  WHERE id = p_refund_id;

  UPDATE proposals SET
    status = 'rejected', rejected_at = NOW(),
    rejection_reason = 'Customer withdrew — deposit refunded (UTR ' || btrim(p_reference) || ')',
    updated_at = NOW()
  WHERE id = v_r.proposal_id;

  RETURN jsonb_build_object('success', true, 'proposal_id', v_r.proposal_id, 'amount', v_r.amount);
END $$;

REVOKE ALL ON FUNCTION request_deposit_refund(UUID,UUID,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approve_deposit_refund(UUID,UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reject_deposit_refund(UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pay_deposit_refund(UUID,UUID,DATE,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION request_deposit_refund(UUID,UUID,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION approve_deposit_refund(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION reject_deposit_refund(UUID,UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION pay_deposit_refund(UUID,UUID,DATE,TEXT,TEXT,TEXT) TO service_role;
