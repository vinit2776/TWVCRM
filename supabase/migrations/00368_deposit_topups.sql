-- Deposit top-up: collecting ADDITIONAL security deposit on an already-active
-- contract, either via a Razorpay payment link or manual recording.
--
-- Complements deposit_adjustments (00359/00360), which only draws DOWN a
-- deposit. There was previously no way to add to one after the original
-- proposal-stage collection — an ad-hoc invoice/PI doesn't work for this,
-- since money collected via a regular invoice never touches
-- proposals.deposit_payment_amount and so is invisible to
-- get_deposit_available_balance. This table is the missing inbound side.
--
-- No maker-checker approval, by design — matches how the ORIGINAL deposit
-- collection already works today (proposals/[id]/deposit-payment,
-- proposals/[id]/deposit-link): single-step, recorded/confirmed by
-- accounts/admin, no second approver. A mistaken entry is corrected via
-- reverse_deposit_topup (admin-only) rather than prevented up front.
--
-- Renewal-escalation integration: contracts.deposit_shortfall (set by
-- renew/route.ts as max(0, newDeposit - oldDeposit), previously purely
-- informational) can now actually be collected — a shortfall-linked topup
-- (applies_to_shortfall = true) atomically decrements deposit_shortfall by
-- the amount collected once paid, and reverse_deposit_topup restores it if
-- the entry turns out to be wrong.

CREATE TABLE IF NOT EXISTS deposit_topups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  source_proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,

  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),

  category TEXT NOT NULL
    CHECK (category IN ('seat_expansion', 'risk_buffer', 'customer_requested', 'renewal_escalation', 'other')),
  category_note TEXT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'reversed')),

  collection_method TEXT NOT NULL
    CHECK (collection_method IN ('razorpay_link', 'manual')),

  -- Razorpay link path
  razorpay_payment_link_id TEXT,
  razorpay_payment_link_url TEXT,

  -- Manual / confirmed-payment fields (also filled in on the razorpay path once paid)
  payment_mode TEXT,
  payment_reference TEXT,
  proof_path TEXT,

  -- True when this specific collection is meant to satisfy
  -- contracts.deposit_shortfall (the renewal-escalation gap), rather than a
  -- general top-up (seat expansion / risk buffer / customer request / other).
  applies_to_shortfall BOOLEAN NOT NULL DEFAULT FALSE,

  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,

  reversed_by UUID REFERENCES users(id),
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposit_topups_contract ON deposit_topups(contract_id);
CREATE INDEX IF NOT EXISTS idx_deposit_topups_source_proposal ON deposit_topups(source_proposal_id);
CREATE INDEX IF NOT EXISTS idx_deposit_topups_status ON deposit_topups(status);
CREATE INDEX IF NOT EXISTS idx_deposit_topups_razorpay_link
  ON deposit_topups(razorpay_payment_link_id) WHERE razorpay_payment_link_id IS NOT NULL;

-- Moved here from 00363_deposit_accounting_inbox.sql: the accounting-inbox proof
-- columns for deposit top-ups, which that migration couldn't create because this
-- table didn't exist yet in a from-scratch migration run.
ALTER TABLE deposit_topups
  ADD COLUMN IF NOT EXISTS accounted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS accounted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accounted_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS accounted_proof_path TEXT;

ALTER TABLE deposit_topups
  DROP CONSTRAINT IF EXISTS deposit_topup_accounted_requires_proof;
ALTER TABLE deposit_topups
  ADD CONSTRAINT deposit_topup_accounted_requires_proof
  CHECK (accounted IS NOT TRUE OR accounted_proof_path IS NOT NULL);

-- Moved here from 00364_receivables_followup_and_settlement.sql: the payment
-- follow-up ladder columns for deposit top-ups, same reason as above.
ALTER TABLE deposit_topups
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settlement_id TEXT;

CREATE INDEX IF NOT EXISTS idx_deposit_topups_due
  ON deposit_topups(due_date) WHERE status = 'pending';

ALTER TABLE deposit_topups ENABLE ROW LEVEL SECURITY;

-- RLS stays wide-open for authenticated users, same convention as
-- deposit_adjustments/billing_payments/contract_billing_moratoriums — role
-- gating happens in the RPCs and API routes, not in RLS. Mutations must
-- always go through the RPCs below (never a raw insert/update), since
-- that's where the atomic shortfall bookkeeping lives.
CREATE POLICY "Authenticated users can read deposit_topups"
  ON deposit_topups FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert deposit_topups"
  ON deposit_topups FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update deposit_topups"
  ON deposit_topups FOR UPDATE
  TO authenticated
  USING (true);


-- ── record_deposit_topup_manual ─────────────────────────────────────────────
-- Money already received offline (bank transfer/cash/UPI/cheque) — inserted
-- directly as 'paid'. If applies_to_shortfall, atomically decrements
-- contracts.deposit_shortfall under a row lock so two concurrent top-ups
-- against the same contract's shortfall can't race each other.

CREATE OR REPLACE FUNCTION record_deposit_topup_manual(
  p_contract_id UUID,
  p_amount NUMERIC,
  p_category TEXT,
  p_category_note TEXT,
  p_payment_mode TEXT,
  p_payment_reference TEXT,
  p_proof_path TEXT,
  p_applies_to_shortfall BOOLEAN,
  p_created_by UUID
)
RETURNS TABLE(success BOOLEAN, error TEXT, topup_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_contract UUID;
  v_proposal_id UUID;
  v_new_id UUID;
  v_shortfall NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN QUERY SELECT FALSE, 'Amount must be greater than zero', NULL::UUID;
    RETURN;
  END IF;

  v_source_contract := resolve_deposit_source_contract(p_contract_id);
  SELECT c.proposal_id INTO v_proposal_id FROM contracts c WHERE c.id = v_source_contract;

  IF v_proposal_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'No deposit-collecting proposal found for this contract', NULL::UUID;
    RETURN;
  END IF;

  IF p_applies_to_shortfall THEN
    SELECT deposit_shortfall INTO v_shortfall FROM contracts WHERE id = p_contract_id FOR UPDATE;
    UPDATE contracts SET deposit_shortfall = GREATEST(0, COALESCE(v_shortfall, 0) - p_amount)
    WHERE id = p_contract_id;
  END IF;

  INSERT INTO deposit_topups (
    contract_id, source_proposal_id, amount, category, category_note,
    status, collection_method, payment_mode, payment_reference, proof_path,
    applies_to_shortfall, created_by, paid_at
  ) VALUES (
    p_contract_id, v_proposal_id, p_amount, p_category, p_category_note,
    'paid', 'manual', p_payment_mode, p_payment_reference, p_proof_path,
    COALESCE(p_applies_to_shortfall, FALSE), p_created_by, NOW()
  ) RETURNING id INTO v_new_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_new_id;
END;
$$;


-- ── create_deposit_topup_link ────────────────────────────────────────────────
-- The Razorpay-link path. The API route creates the link with Razorpay
-- FIRST (needs no DB state), then calls this to record the pending row.
-- No shortfall decrement here — money hasn't arrived yet; that happens in
-- mark_deposit_topup_paid once the webhook confirms payment.

CREATE OR REPLACE FUNCTION create_deposit_topup_link(
  p_contract_id UUID,
  p_amount NUMERIC,
  p_category TEXT,
  p_category_note TEXT,
  p_applies_to_shortfall BOOLEAN,
  p_created_by UUID,
  p_razorpay_link_id TEXT,
  p_razorpay_link_url TEXT
)
RETURNS TABLE(success BOOLEAN, error TEXT, topup_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_contract UUID;
  v_proposal_id UUID;
  v_new_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN QUERY SELECT FALSE, 'Amount must be greater than zero', NULL::UUID;
    RETURN;
  END IF;

  v_source_contract := resolve_deposit_source_contract(p_contract_id);
  SELECT c.proposal_id INTO v_proposal_id FROM contracts c WHERE c.id = v_source_contract;

  IF v_proposal_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'No deposit-collecting proposal found for this contract', NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO deposit_topups (
    contract_id, source_proposal_id, amount, category, category_note,
    status, collection_method, razorpay_payment_link_id, razorpay_payment_link_url,
    applies_to_shortfall, created_by
  ) VALUES (
    p_contract_id, v_proposal_id, p_amount, p_category, p_category_note,
    'pending', 'razorpay_link', p_razorpay_link_id, p_razorpay_link_url,
    COALESCE(p_applies_to_shortfall, FALSE), p_created_by
  ) RETURNING id INTO v_new_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_new_id;
END;
$$;


-- ── mark_deposit_topup_paid ─────────────────────────────────────────────────
-- Called by the Razorpay webhook once payment_link.paid fires. Idempotent —
-- only acts on a row still 'pending', so a duplicate webhook delivery
-- (Razorpay retries) is a safe no-op on the second call.

CREATE OR REPLACE FUNCTION mark_deposit_topup_paid(
  p_razorpay_payment_link_id TEXT,
  p_razorpay_payment_id TEXT
)
RETURNS TABLE(success BOOLEAN, error TEXT, topup_id UUID, contract_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_topup RECORD;
  v_shortfall NUMERIC;
BEGIN
  SELECT * INTO v_topup FROM deposit_topups
  WHERE razorpay_payment_link_id = p_razorpay_payment_link_id
  FOR UPDATE;

  IF v_topup IS NULL THEN
    RETURN QUERY SELECT FALSE, 'No top-up found for this payment link', NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF v_topup.status != 'pending' THEN
    RETURN QUERY SELECT FALSE, format('Top-up already %s', v_topup.status), v_topup.id, v_topup.contract_id;
    RETURN;
  END IF;

  IF v_topup.applies_to_shortfall THEN
    SELECT deposit_shortfall INTO v_shortfall FROM contracts WHERE id = v_topup.contract_id FOR UPDATE;
    UPDATE contracts SET deposit_shortfall = GREATEST(0, COALESCE(v_shortfall, 0) - v_topup.amount)
    WHERE id = v_topup.contract_id;
  END IF;

  UPDATE deposit_topups SET
    status = 'paid',
    paid_at = NOW(),
    payment_reference = p_razorpay_payment_id,
    updated_at = NOW()
  WHERE id = v_topup.id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_topup.id, v_topup.contract_id;
END;
$$;


-- ── reverse_deposit_topup ────────────────────────────────────────────────────
-- Admin-only correction path for a mistaken entry (wrong amount, wrong
-- contract). Restores whatever it had reduced: the shortfall figure (if
-- linked) and, automatically, the available-deposit balance, since that's
-- computed live from SUM(status = 'paid') and a reversed row drops out of
-- that sum.

CREATE OR REPLACE FUNCTION reverse_deposit_topup(
  p_topup_id UUID,
  p_reversed_by UUID,
  p_reason TEXT
)
RETURNS TABLE(success BOOLEAN, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_topup RECORD;
  v_role TEXT;
  v_shortfall NUMERIC;
BEGIN
  SELECT * INTO v_topup FROM deposit_topups WHERE id = p_topup_id FOR UPDATE;

  IF v_topup IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Top-up not found';
    RETURN;
  END IF;

  IF v_topup.status != 'paid' THEN
    RETURN QUERY SELECT FALSE, format('Only a paid top-up can be reversed (status: %s)', v_topup.status);
    RETURN;
  END IF;

  SELECT role INTO v_role FROM users WHERE id = p_reversed_by;
  IF v_role IS NULL OR v_role != 'admin' THEN
    RETURN QUERY SELECT FALSE, 'Only admin can reverse a deposit top-up';
    RETURN;
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN QUERY SELECT FALSE, 'A reversal reason is required';
    RETURN;
  END IF;

  IF v_topup.applies_to_shortfall THEN
    SELECT deposit_shortfall INTO v_shortfall FROM contracts WHERE id = v_topup.contract_id FOR UPDATE;
    UPDATE contracts SET deposit_shortfall = COALESCE(v_shortfall, 0) + v_topup.amount
    WHERE id = v_topup.contract_id;
  END IF;

  UPDATE deposit_topups SET
    status = 'reversed',
    reversed_by = p_reversed_by,
    reversed_at = NOW(),
    reversal_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_topup_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT;
END;
$$;


-- ── Extend get_deposit_available_balance + request_deposit_adjustment ───────
-- Both need paid top-ups added into "collected", since a top-up genuinely
-- increases what a future adjustment (drawdown) can draw against.

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
  v_topups NUMERIC;
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

  SELECT COALESCE(SUM(dt.amount), 0) INTO v_topups
  FROM deposit_topups dt
  WHERE dt.source_proposal_id = v_proposal_id AND dt.status = 'paid';

  IF v_deposit_status IS DISTINCT FROM 'paid' THEN
    -- No original deposit collected, but top-ups can still exist (e.g. a
    -- risk-buffer top-up on a contract whose deposit was waived) — count them.
    RETURN QUERY SELECT v_source_contract, v_proposal_id, v_topups, 0::NUMERIC, v_topups;
    RETURN;
  END IF;

  v_collected := COALESCE(v_deposit_paid_amount, v_deposit_amount, 0) + v_topups;

  SELECT COALESCE(SUM(da.amount), 0) INTO v_committed
  FROM deposit_adjustments da
  WHERE da.source_proposal_id = v_proposal_id
    AND da.status IN ('pending_approval', 'approved');

  RETURN QUERY SELECT v_source_contract, v_proposal_id, v_collected, v_committed,
    GREATEST(v_collected - v_committed, 0)::NUMERIC;
END;
$$;


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
  v_topups NUMERIC;
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

  SELECT COALESCE(SUM(dt.amount), 0) INTO v_topups
  FROM deposit_topups dt
  WHERE dt.source_proposal_id = v_proposal_id AND dt.status = 'paid';

  IF v_deposit_status IS DISTINCT FROM 'paid' AND v_topups = 0 THEN
    RETURN QUERY SELECT FALSE, 'No paid deposit found for this contract', NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  v_collected := COALESCE(v_deposit_paid_amount, v_deposit_amount, 0) + v_topups;

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
