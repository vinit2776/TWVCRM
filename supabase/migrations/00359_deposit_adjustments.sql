-- Deposit adjustment as a payment mode (maker-checker), Issue #235
--
-- Lets accounts net a customer's held security deposit against an
-- outstanding invoice, gated by admin/manager approval before the deposit
-- balance or billing_payments actually move. Modeled on
-- contract_billing_moratoriums (dedicated table + status enum, insert as
-- pending, mutate ledger only on approve) rather than the generic
-- approval_requests table, since this needs typed columns + FK integrity
-- for a real financial ledger, not a JSON metadata blob. The atomic
-- balance-check pattern follows redeem_prepaid_credits (00153) — lock the
-- deposit-holding proposal row, validate no overdraw, insert.
--
-- "Available deposit" is computed per source_proposal_id, not per
-- contract_id: a renewed contract's deposit still lives on whichever
-- ancestor contract's proposal originally collected it
-- (contracts.deposit_carried_from chain), so the balance and its FOR UPDATE
-- lock must key off that resolved proposal, summed across every contract in
-- the renewal family that has drawn against it — otherwise a renewal chain
-- could double-spend the same deposit across two contracts.

CREATE TABLE IF NOT EXISTS deposit_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  source_proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  billing_statement_id UUID NOT NULL REFERENCES billing_statements(id) ON DELETE RESTRICT,
  billing_payment_id UUID REFERENCES billing_payments(id) ON DELETE SET NULL,

  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),

  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'approved', 'rejected', 'reversed')),

  requested_by UUID NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,

  rejected_by UUID REFERENCES users(id),
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,

  reversed_by UUID REFERENCES users(id),
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,

  notify_customer BOOLEAN NOT NULL DEFAULT FALSE,
  customer_notified_at TIMESTAMPTZ,
  accounts_notified_at TIMESTAMPTZ,

  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposit_adjustments_contract ON deposit_adjustments(contract_id);
CREATE INDEX IF NOT EXISTS idx_deposit_adjustments_source_proposal ON deposit_adjustments(source_proposal_id);
CREATE INDEX IF NOT EXISTS idx_deposit_adjustments_statement ON deposit_adjustments(billing_statement_id);
CREATE INDEX IF NOT EXISTS idx_deposit_adjustments_status ON deposit_adjustments(status);
-- Fast "does this contract have a pending request" lookup for the contract-page banner
CREATE INDEX IF NOT EXISTS idx_deposit_adjustments_pending_by_contract
  ON deposit_adjustments(contract_id) WHERE status = 'pending_approval';

ALTER TABLE deposit_adjustments ENABLE ROW LEVEL SECURITY;

-- RLS stays wide-open for authenticated users (matches billing_payments,
-- prepaid_purchases, contract_billing_moratoriums) — role gating and
-- self-approval blocking happen in the RPCs below and in the API routes
-- that call them, not in RLS. Direct client INSERT/UPDATE against this
-- table bypasses the maker-checker guarantees entirely, so the API layer
-- must always go through the RPCs (never a raw insert/update).
CREATE POLICY "Authenticated users can read deposit_adjustments"
  ON deposit_adjustments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert deposit_adjustments"
  ON deposit_adjustments FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update deposit_adjustments"
  ON deposit_adjustments FOR UPDATE
  TO authenticated
  USING (true);


-- ── resolve_deposit_source_contract ─────────────────────────────────────────
-- Walks contracts.deposit_carried_from back to the contract whose own
-- proposal actually collected the deposit money. Bounded to 25 hops as a
-- guard against a corrupted/cyclic chain rather than an infinite loop.

CREATE OR REPLACE FUNCTION resolve_deposit_source_contract(p_contract_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current UUID := p_contract_id;
  v_parent UUID;
  v_hops INT := 0;
BEGIN
  LOOP
    v_hops := v_hops + 1;
    IF v_hops > 25 THEN
      RAISE EXCEPTION 'deposit_carried_from chain exceeds 25 hops for contract %', p_contract_id;
    END IF;

    SELECT deposit_carried_from INTO v_parent FROM contracts WHERE id = v_current;

    IF v_parent IS NULL THEN
      RETURN v_current;
    END IF;

    v_current := v_parent;
  END LOOP;
END;
$$;


-- ── get_deposit_available_balance ───────────────────────────────────────────
-- Read-only. For UI display when opening the "Adjustment against deposit"
-- form — not used for the actual write-path lock (request_deposit_adjustment
-- re-derives everything fresh under FOR UPDATE, since this value can go
-- stale between page load and submit).

CREATE OR REPLACE FUNCTION get_deposit_available_balance(p_contract_id UUID)
RETURNS TABLE(
  source_contract_id UUID,
  source_proposal_id UUID,
  deposit_collected NUMERIC,
  committed NUMERIC,
  available NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_contract UUID;
  v_proposal_id UUID;
  v_deposit_status TEXT;
  v_deposit_amount NUMERIC;
  v_deposit_paid_amount NUMERIC;
  v_collected NUMERIC;
  v_committed NUMERIC;
BEGIN
  v_source_contract := resolve_deposit_source_contract(p_contract_id);

  SELECT c.proposal_id INTO v_proposal_id FROM contracts c WHERE c.id = v_source_contract;

  IF v_proposal_id IS NULL THEN
    RETURN QUERY SELECT v_source_contract, NULL::UUID, 0::NUMERIC, 0::NUMERIC, 0::NUMERIC;
    RETURN;
  END IF;

  SELECT p.deposit_payment_status, p.security_deposit_amount, p.deposit_payment_amount
  INTO v_deposit_status, v_deposit_amount, v_deposit_paid_amount
  FROM proposals p WHERE p.id = v_proposal_id;

  IF v_deposit_status IS DISTINCT FROM 'paid' THEN
    RETURN QUERY SELECT v_source_contract, v_proposal_id, 0::NUMERIC, 0::NUMERIC, 0::NUMERIC;
    RETURN;
  END IF;

  v_collected := COALESCE(v_deposit_paid_amount, v_deposit_amount, 0);

  SELECT COALESCE(SUM(da.amount), 0) INTO v_committed
  FROM deposit_adjustments da
  WHERE da.source_proposal_id = v_proposal_id
    AND da.status IN ('pending_approval', 'approved');

  RETURN QUERY SELECT v_source_contract, v_proposal_id, v_collected, v_committed,
    GREATEST(v_collected - v_committed, 0)::NUMERIC;
END;
$$;


-- ── request_deposit_adjustment ──────────────────────────────────────────────
-- The write path. Locks the source proposal row for the duration of the
-- balance check + insert so two concurrent requests against the same
-- deposit can't both pass the overdraw check (mirrors redeem_prepaid_credits'
-- FOR UPDATE pattern). A pending request reserves its amount immediately —
-- committed = SUM(pending_approval + approved) — so a second request can't
-- draw against funds the first one is already waiting on.

CREATE OR REPLACE FUNCTION request_deposit_adjustment(
  p_contract_id UUID,
  p_billing_statement_id UUID,
  p_amount NUMERIC,
  p_requested_by UUID,
  p_notify_customer BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(success BOOLEAN, error TEXT, adjustment_id UUID, available_after NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_contract UUID;
  v_proposal_id UUID;
  v_deposit_status TEXT;
  v_deposit_amount NUMERIC;
  v_deposit_paid_amount NUMERIC;
  v_collected NUMERIC;
  v_committed NUMERIC;
  v_available NUMERIC;
  v_statement_status TEXT;
  v_statement_contract UUID;
  v_new_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN QUERY SELECT FALSE, 'Amount must be greater than zero', NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  SELECT bs.status, bs.contract_id INTO v_statement_status, v_statement_contract
  FROM billing_statements bs WHERE bs.id = p_billing_statement_id;

  IF v_statement_status IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Billing statement not found', NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  IF v_statement_contract IS DISTINCT FROM p_contract_id THEN
    RETURN QUERY SELECT FALSE, 'Billing statement does not belong to this contract', NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  IF v_statement_status NOT IN ('finalized', 'exported') THEN
    RETURN QUERY SELECT FALSE,
      'Statement must be finalized or exported before recording a deposit adjustment',
      NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  v_source_contract := resolve_deposit_source_contract(p_contract_id);

  SELECT c.proposal_id INTO v_proposal_id FROM contracts c WHERE c.id = v_source_contract;

  IF v_proposal_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'No deposit-collecting proposal found for this contract',
      NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  -- Lock the source proposal row for the duration of the balance check + insert
  SELECT p.deposit_payment_status, p.security_deposit_amount, p.deposit_payment_amount
  INTO v_deposit_status, v_deposit_amount, v_deposit_paid_amount
  FROM proposals p WHERE p.id = v_proposal_id
  FOR UPDATE;

  IF v_deposit_status IS DISTINCT FROM 'paid' THEN
    RETURN QUERY SELECT FALSE, 'No paid deposit found for this contract', NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  v_collected := COALESCE(v_deposit_paid_amount, v_deposit_amount, 0);

  SELECT COALESCE(SUM(da.amount), 0) INTO v_committed
  FROM deposit_adjustments da
  WHERE da.source_proposal_id = v_proposal_id
    AND da.status IN ('pending_approval', 'approved');

  v_available := v_collected - v_committed;

  IF p_amount > v_available + 0.01 THEN
    RETURN QUERY SELECT FALSE,
      format('Amount exceeds available deposit balance (available: %s)', ROUND(v_available, 2)),
      NULL::UUID, v_available;
    RETURN;
  END IF;

  INSERT INTO deposit_adjustments (
    contract_id, source_proposal_id, billing_statement_id, amount,
    status, requested_by, notify_customer
  ) VALUES (
    p_contract_id, v_proposal_id, p_billing_statement_id, p_amount,
    'pending_approval', p_requested_by, COALESCE(p_notify_customer, FALSE)
  ) RETURNING id INTO v_new_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_new_id, (v_available - p_amount);
END;
$$;


-- ── approve_deposit_adjustment ──────────────────────────────────────────────
-- Blocks self-approval and role at the DB layer (defense in depth — the API
-- route must also check this, but neither contract_billing_moratoriums nor
-- approval_requests enforce self-approval blocking today, so this table
-- doesn't inherit that gap). Re-validates the statement is still
-- finalized/exported, since it could have been voided or otherwise changed
-- between request and approval. Creates the billing_payments row here, in
-- the same lock, so the invoice never briefly shows "settled" without the
-- deposit actually having moved.

CREATE OR REPLACE FUNCTION approve_deposit_adjustment(
  p_adjustment_id UUID,
  p_approved_by UUID
)
RETURNS TABLE(success BOOLEAN, error TEXT, billing_payment_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_adj RECORD;
  v_approver_role TEXT;
  v_statement_status TEXT;
  v_payment_id UUID;
BEGIN
  SELECT * INTO v_adj FROM deposit_adjustments WHERE id = p_adjustment_id FOR UPDATE;

  IF v_adj IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Adjustment not found', NULL::UUID;
    RETURN;
  END IF;

  IF v_adj.status != 'pending_approval' THEN
    RETURN QUERY SELECT FALSE, format('Adjustment is not pending approval (status: %s)', v_adj.status), NULL::UUID;
    RETURN;
  END IF;

  IF v_adj.requested_by = p_approved_by THEN
    RETURN QUERY SELECT FALSE, 'The requester cannot approve their own adjustment', NULL::UUID;
    RETURN;
  END IF;

  SELECT role INTO v_approver_role FROM users WHERE id = p_approved_by;

  IF v_approver_role IS NULL OR v_approver_role NOT IN ('admin', 'manager') THEN
    RETURN QUERY SELECT FALSE, 'Only admin or manager can approve a deposit adjustment', NULL::UUID;
    RETURN;
  END IF;

  SELECT status INTO v_statement_status FROM billing_statements WHERE id = v_adj.billing_statement_id;

  IF v_statement_status IS NULL OR v_statement_status NOT IN ('finalized', 'exported') THEN
    RETURN QUERY SELECT FALSE,
      format('Statement is no longer finalized/exported (status: %s) — cannot approve', v_statement_status),
      NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO billing_payments (
    billing_statement_id, amount, payment_date, payment_mode,
    payment_reference, notes, recorded_by
  ) VALUES (
    v_adj.billing_statement_id, v_adj.amount, CURRENT_DATE, 'deposit_adjustment',
    v_adj.id::TEXT, 'Adjustment against security deposit', p_approved_by
  ) RETURNING id INTO v_payment_id;

  UPDATE deposit_adjustments SET
    status = 'approved',
    approved_by = p_approved_by,
    approved_at = NOW(),
    billing_payment_id = v_payment_id,
    updated_at = NOW()
  WHERE id = p_adjustment_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_payment_id;
END;
$$;


-- ── reject_deposit_adjustment ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION reject_deposit_adjustment(
  p_adjustment_id UUID,
  p_rejected_by UUID,
  p_reason TEXT
)
RETURNS TABLE(success BOOLEAN, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_adj RECORD;
  v_role TEXT;
BEGIN
  SELECT * INTO v_adj FROM deposit_adjustments WHERE id = p_adjustment_id FOR UPDATE;

  IF v_adj IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Adjustment not found';
    RETURN;
  END IF;

  IF v_adj.status != 'pending_approval' THEN
    RETURN QUERY SELECT FALSE, format('Adjustment is not pending approval (status: %s)', v_adj.status);
    RETURN;
  END IF;

  IF v_adj.requested_by = p_rejected_by THEN
    RETURN QUERY SELECT FALSE, 'The requester cannot reject their own adjustment';
    RETURN;
  END IF;

  SELECT role INTO v_role FROM users WHERE id = p_rejected_by;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
    RETURN QUERY SELECT FALSE, 'Only admin or manager can reject a deposit adjustment';
    RETURN;
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN QUERY SELECT FALSE, 'A rejection reason is required';
    RETURN;
  END IF;

  UPDATE deposit_adjustments SET
    status = 'rejected',
    rejected_by = p_rejected_by,
    rejected_at = NOW(),
    rejection_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_adjustment_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT;
END;
$$;


-- ── reverse_deposit_adjustment ───────────────────────────────────────────────
-- Admin-only, single-step (per the filed spec — no second approver on the
-- reversal itself). Deletes the linked billing_payments row rather than
-- adding a "voided" flag to that shared table, which automatically
-- unblocks statement void (void/route.ts already blocks void once any
-- billing_payments row exists) with zero changes needed to the void route.
-- The deposit_adjustments row itself is never deleted — status flips to
-- 'reversed' so the full history stays on the contract.

CREATE OR REPLACE FUNCTION reverse_deposit_adjustment(
  p_adjustment_id UUID,
  p_reversed_by UUID,
  p_reason TEXT
)
RETURNS TABLE(success BOOLEAN, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_adj RECORD;
  v_role TEXT;
BEGIN
  SELECT * INTO v_adj FROM deposit_adjustments WHERE id = p_adjustment_id FOR UPDATE;

  IF v_adj IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Adjustment not found';
    RETURN;
  END IF;

  IF v_adj.status != 'approved' THEN
    RETURN QUERY SELECT FALSE, format('Only an approved adjustment can be reversed (status: %s)', v_adj.status);
    RETURN;
  END IF;

  SELECT role INTO v_role FROM users WHERE id = p_reversed_by;

  IF v_role IS NULL OR v_role != 'admin' THEN
    RETURN QUERY SELECT FALSE, 'Only admin can reverse a deposit adjustment';
    RETURN;
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN QUERY SELECT FALSE, 'A reversal reason is required';
    RETURN;
  END IF;

  IF v_adj.billing_payment_id IS NOT NULL THEN
    DELETE FROM billing_payments WHERE id = v_adj.billing_payment_id;
  END IF;

  UPDATE deposit_adjustments SET
    status = 'reversed',
    reversed_by = p_reversed_by,
    reversed_at = NOW(),
    reversal_reason = p_reason,
    billing_payment_id = NULL,
    updated_at = NOW()
  WHERE id = p_adjustment_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT;
END;
$$;
