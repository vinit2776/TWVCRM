-- 00649_deposit_instalments.sql
-- Staged security deposit: sales can take a proposal's deposit in parts
-- (e.g. ₹20,000 of ₹60,000 now) while the activation rule stays exactly as it
-- is — the deposit must be paid in full.
--
-- Model: the required deposit is still ONE obligation on the proposal. Each
-- "ask" is a row here with its own amount, Razorpay link and due date. The
-- proposal's completed-deposit fields (deposit_payment_status = 'paid',
-- deposit_payment_amount, reference, medium, received_at) are written ONLY when
-- the parts paid add up to the required amount, so everything that treats
-- "paid" as "complete" (activation gate, contract snapshot, deposit pool, exit
-- refund, revise lock) cannot be fooled by a part.
--
-- The first part paid accepts the proposal (as the single deposit payment does
-- today), which locks its terms.
--
-- Ships dark: deposit_instalments_enabled = 'false'. Nothing creates a row until
-- an admin switches it on, so this migration changes no behaviour by itself.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS cancel_deposit_instalment(UUID, UUID, TEXT);
--   DROP FUNCTION IF EXISTS record_deposit_payment_for_link(TEXT, TEXT, NUMERIC);
--   DROP FUNCTION IF EXISTS record_deposit_instalment_paid(UUID, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT);
--   DROP FUNCTION IF EXISTS request_deposit_instalment(UUID, NUMERIC, DATE, TEXT, TEXT, UUID, UUID, TEXT);
--   DROP FUNCTION IF EXISTS _rollup_proposal_deposit(UUID);
--   DROP TABLE IF EXISTS proposal_deposit_instalments;
--   DELETE FROM app_settings WHERE key IN ('deposit_instalments_enabled', 'deposit_min_first_part_percent');
-- (If any instalment was paid, first restore the proposal's deposit_payment_* fields by hand.)

CREATE TABLE IF NOT EXISTS proposal_deposit_instalments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq > 0),

  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'paid', 'cancelled')),
  due_date DATE,

  razorpay_link_id TEXT,
  razorpay_link_url TEXT,

  -- Internal-only, never sent to the customer (same split as the single deposit).
  internal_note TEXT,
  customer_message TEXT,

  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- First part below the minimum slice: who approved it and why.
  floor_override_by UUID REFERENCES users(id) ON DELETE SET NULL,
  floor_override_reason TEXT,

  paid_amount NUMERIC(12,2),
  paid_at TIMESTAMPTZ,
  payment_reference TEXT,
  payment_medium TEXT,
  payment_screenshot_url TEXT,
  payment_notes TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,

  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason TEXT,

  -- Razorpay settlement stamps and Tally Inbox booking — written by later work
  -- (reconciliation / accounts view); present now so that needs no second migration.
  settled_at TIMESTAMPTZ,
  settlement_id TEXT,
  accounted BOOLEAN NOT NULL DEFAULT FALSE,
  accounted_at TIMESTAMPTZ,
  accounted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  accounted_proof_path TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT proposal_deposit_instalments_seq_unique UNIQUE (proposal_id, seq),
  CONSTRAINT proposal_deposit_instalments_paid_has_amount
    CHECK (status <> 'paid' OR (paid_amount IS NOT NULL AND paid_amount > 0 AND paid_at IS NOT NULL))
);

-- One open (unpaid) ask per proposal at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_instalments_one_open
  ON proposal_deposit_instalments(proposal_id) WHERE status = 'requested';
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_instalments_link
  ON proposal_deposit_instalments(razorpay_link_id) WHERE razorpay_link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deposit_instalments_proposal
  ON proposal_deposit_instalments(proposal_id);

ALTER TABLE proposal_deposit_instalments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read deposit instalments" ON proposal_deposit_instalments;
CREATE POLICY "Authenticated can read deposit instalments"
  ON proposal_deposit_instalments FOR SELECT TO authenticated USING (true);

-- Settings: switched off by default; first-slice floor as a percentage.
INSERT INTO app_settings (key, value) VALUES ('deposit_instalments_enabled', 'false')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO app_settings (key, value) VALUES ('deposit_min_first_part_percent', '25')
  ON CONFLICT (key) DO NOTHING;

-- ── Roll-up ───────────────────────────────────────────────────────────────────
-- Caller must already hold the proposal row lock. Writes the completed-deposit
-- fields only when the parts paid reach the required amount.
CREATE OR REPLACE FUNCTION _rollup_proposal_deposit(p_proposal_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p proposals%ROWTYPE;
  v_required NUMERIC;
  v_paid NUMERIC;
  v_parts INTEGER;
  v_refs TEXT;
  v_medium TEXT;
  v_complete BOOLEAN := FALSE;
BEGIN
  SELECT * INTO p FROM proposals WHERE id = p_proposal_id;
  v_required := GREATEST(0,
    COALESCE(p.security_deposit_amount, 0) + COALESCE(p.deposit_exception_amount, 0) - COALESCE(p.deposit_credit_amount, 0));

  SELECT COALESCE(SUM(paid_amount), 0), COUNT(*)
    INTO v_paid, v_parts
    FROM proposal_deposit_instalments WHERE proposal_id = p_proposal_id AND status = 'paid';

  -- Also re-runs when the deposit is already complete and a further payment
  -- lands (an over-payment): the amount held must match the money received.
  IF v_required > 0 AND v_paid >= v_required
     AND (p.deposit_payment_status IS DISTINCT FROM 'paid' OR p.deposit_payment_amount IS DISTINCT FROM v_paid) THEN
    SELECT string_agg(COALESCE(NULLIF(payment_reference, ''), '—'), ', ' ORDER BY seq),
           CASE WHEN COUNT(DISTINCT COALESCE(payment_medium, '')) = 1 THEN MIN(payment_medium) ELSE 'multiple' END
      INTO v_refs, v_medium
      FROM proposal_deposit_instalments WHERE proposal_id = p_proposal_id AND status = 'paid';

    UPDATE proposals SET
      deposit_payment_status = 'paid',
      deposit_payment_amount = v_paid,
      deposit_payment_received_at = CASE WHEN p.deposit_payment_status = 'paid' THEN p.deposit_payment_received_at ELSE NOW() END,
      deposit_payment_reference = v_refs,
      deposit_payment_medium = v_medium
    WHERE id = p_proposal_id;
    v_complete := TRUE;
  END IF;

  RETURN jsonb_build_object(
    'required', v_required, 'paid', v_paid, 'parts_paid', v_parts,
    'complete', v_complete OR p.deposit_payment_status = 'paid'
  );
END;
$$;

-- ── Request a part ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION request_deposit_instalment(
  p_proposal_id UUID,
  p_amount NUMERIC,
  p_due_date DATE,
  p_internal_note TEXT,
  p_customer_message TEXT,
  p_actor UUID,
  p_override_by UUID,
  p_override_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p proposals%ROWTYPE;
  v_required NUMERIC;
  v_paid NUMERIC;
  v_balance NUMERIC;
  v_pct NUMERIC;
  v_floor NUMERIC;
  v_seq INTEGER;
  v_id UUID;
  v_below BOOLEAN;
  v_override BOOLEAN := p_override_by IS NOT NULL AND COALESCE(length(btrim(p_override_reason)), 0) >= 10;
BEGIN
  SELECT * INTO p FROM proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'proposal_not_found'); END IF;
  IF p.status NOT IN ('sent', 'viewed', 'accepted') THEN
    RETURN jsonb_build_object('success', false, 'error', 'proposal_not_open');
  END IF;
  IF p.deposit_payment_status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'deposit_not_pending');
  END IF;

  v_required := GREATEST(0,
    COALESCE(p.security_deposit_amount, 0) + COALESCE(p.deposit_exception_amount, 0) - COALESCE(p.deposit_credit_amount, 0));
  IF v_required <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'nothing_to_collect'); END IF;

  IF EXISTS (SELECT 1 FROM proposal_deposit_instalments WHERE proposal_id = p_proposal_id AND status = 'requested') THEN
    RETURN jsonb_build_object('success', false, 'error', 'open_ask_exists');
  END IF;

  SELECT COALESCE(SUM(paid_amount), 0) INTO v_paid
    FROM proposal_deposit_instalments WHERE proposal_id = p_proposal_id AND status = 'paid';
  v_balance := v_required - v_paid;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > v_balance THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount_exceeds_balance', 'balance', v_balance);
  END IF;

  -- Minimum first slice. Asking for the whole balance is always fine.
  SELECT NULLIF(btrim(value), '')::NUMERIC INTO v_pct FROM app_settings WHERE key = 'deposit_min_first_part_percent';
  v_pct := COALESCE(v_pct, 25);
  v_floor := CEIL(v_required * v_pct / 100);
  v_below := v_paid = 0 AND p_amount < v_balance AND p_amount < v_floor;
  IF v_below AND NOT v_override THEN
    RETURN jsonb_build_object('success', false, 'error', 'below_floor', 'floor', v_floor, 'percent', v_pct);
  END IF;

  SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq FROM proposal_deposit_instalments WHERE proposal_id = p_proposal_id;

  INSERT INTO proposal_deposit_instalments (
    proposal_id, seq, amount, due_date, internal_note, customer_message, requested_by,
    floor_override_by, floor_override_reason
  ) VALUES (
    p_proposal_id, v_seq, p_amount, p_due_date, p_internal_note, NULLIF(btrim(COALESCE(p_customer_message, '')), ''), p_actor,
    CASE WHEN v_below THEN p_override_by END,
    CASE WHEN v_below THEN btrim(p_override_reason) END
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'instalment_id', v_id, 'seq', v_seq, 'amount', p_amount,
    'required', v_required, 'paid', v_paid, 'first_part', v_seq = 1);
END;
$$;

-- ── Mark a part paid (manual recording, or the webhook via the link wrapper) ──
CREATE OR REPLACE FUNCTION record_deposit_instalment_paid(
  p_instalment_id UUID,
  p_amount NUMERIC,
  p_reference TEXT,
  p_medium TEXT,
  p_paid_at TIMESTAMPTZ,
  p_screenshot TEXT,
  p_recorded_by UUID,
  p_notes TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proposal_id UUID;
  i proposal_deposit_instalments%ROWTYPE;
  p proposals%ROWTYPE;
  v_accepted BOOLEAN := FALSE;
  v_roll JSONB;
BEGIN
  SELECT proposal_id INTO v_proposal_id FROM proposal_deposit_instalments WHERE id = p_instalment_id;
  IF v_proposal_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'instalment_not_found'); END IF;

  -- Proposal first, then the part: same order as every other function here.
  SELECT * INTO p FROM proposals WHERE id = v_proposal_id FOR UPDATE;
  SELECT * INTO i FROM proposal_deposit_instalments WHERE id = p_instalment_id FOR UPDATE;

  IF i.status = 'paid' THEN
    RETURN jsonb_build_object('success', true, 'already_paid', true, 'proposal_id', v_proposal_id, 'instalment_id', i.id);
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_amount'); END IF;

  -- A late payment on a cancelled ask is still real money: record it, keep the
  -- cancellation history on the row.
  UPDATE proposal_deposit_instalments SET
    status = 'paid',
    paid_amount = p_amount,
    paid_at = COALESCE(p_paid_at, NOW()),
    payment_reference = p_reference,
    payment_medium = p_medium,
    payment_screenshot_url = p_screenshot,
    payment_notes = p_notes,
    recorded_by = p_recorded_by,
    updated_at = NOW()
  WHERE id = p_instalment_id;

  -- The first part secures the customer: accept the proposal, unless it is a
  -- dead deal (the money is recorded either way; a human decides about those).
  IF p.status IN ('draft', 'sent', 'viewed') THEN
    UPDATE proposals SET status = 'accepted', accepted_at = NOW() WHERE id = v_proposal_id;
    v_accepted := TRUE;
  END IF;

  v_roll := _rollup_proposal_deposit(v_proposal_id);

  RETURN jsonb_build_object('success', true, 'proposal_id', v_proposal_id, 'instalment_id', p_instalment_id,
    'proposal_number', p.proposal_number, 'proposal_status_before', p.status, 'accepted_now', v_accepted,
    'required', v_roll->'required', 'paid', v_roll->'paid', 'complete', v_roll->'complete');
END;
$$;

-- ── Webhook wrapper: find a part by its link, or a late payment on the
--    proposal's original full-deposit link once parts exist ───────────────────
CREATE OR REPLACE FUNCTION record_deposit_payment_for_link(
  p_link_id TEXT,
  p_payment_id TEXT,
  p_amount NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inst_id UUID;
  v_proposal_id UUID;
  v_seq INTEGER;
BEGIN
  SELECT id INTO v_inst_id FROM proposal_deposit_instalments WHERE razorpay_link_id = p_link_id;
  IF v_inst_id IS NOT NULL THEN
    RETURN record_deposit_instalment_paid(v_inst_id, p_amount, p_payment_id, 'razorpay', NOW(), NULL, NULL, NULL)
      || jsonb_build_object('matched', true);
  END IF;

  -- The proposal's original full-deposit link, paid after parts were requested.
  SELECT id INTO v_proposal_id FROM proposals
    WHERE deposit_razorpay_link_id = p_link_id
      AND EXISTS (SELECT 1 FROM proposal_deposit_instalments d WHERE d.proposal_id = proposals.id);
  IF v_proposal_id IS NULL THEN
    RETURN jsonb_build_object('matched', false);
  END IF;

  PERFORM 1 FROM proposals WHERE id = v_proposal_id FOR UPDATE;
  SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq FROM proposal_deposit_instalments WHERE proposal_id = v_proposal_id;
  -- Inserted as 'cancelled' so it can never collide with the one-open-ask rule;
  -- the payment below flips it to 'paid' (money is recorded whatever the state).
  INSERT INTO proposal_deposit_instalments (
    proposal_id, seq, amount, status, razorpay_link_id, internal_note, cancelled_at, cancel_reason
  ) VALUES (
    v_proposal_id, v_seq, p_amount, 'cancelled', p_link_id,
    'Paid through the proposal''s original full-deposit link after parts had been requested.',
    NOW(), 'Original full-deposit link — withdrawn when parts were requested'
  ) RETURNING id INTO v_inst_id;
  RETURN record_deposit_instalment_paid(v_inst_id, p_amount, p_payment_id, 'razorpay', NOW(), NULL, NULL, NULL)
    || jsonb_build_object('matched', true, 'via_original_link', true);
END;
$$;

-- ── Withdraw an unpaid ask ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cancel_deposit_instalment(
  p_instalment_id UUID,
  p_actor UUID,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proposal_id UUID;
  i proposal_deposit_instalments%ROWTYPE;
BEGIN
  SELECT proposal_id INTO v_proposal_id FROM proposal_deposit_instalments WHERE id = p_instalment_id;
  IF v_proposal_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'instalment_not_found'); END IF;
  PERFORM 1 FROM proposals WHERE id = v_proposal_id FOR UPDATE;
  SELECT * INTO i FROM proposal_deposit_instalments WHERE id = p_instalment_id FOR UPDATE;
  IF i.status <> 'requested' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_open', 'status', i.status);
  END IF;
  UPDATE proposal_deposit_instalments SET
    status = 'cancelled', cancelled_at = NOW(), cancelled_by = p_actor, cancel_reason = p_reason, updated_at = NOW()
  WHERE id = p_instalment_id;
  RETURN jsonb_build_object('success', true, 'proposal_id', v_proposal_id, 'razorpay_link_id', i.razorpay_link_id);
END;
$$;

-- Server-only: called from API routes and the webhook with the service role.
REVOKE ALL ON FUNCTION _rollup_proposal_deposit(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION request_deposit_instalment(UUID, NUMERIC, DATE, TEXT, TEXT, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION record_deposit_instalment_paid(UUID, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION record_deposit_payment_for_link(TEXT, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION cancel_deposit_instalment(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION request_deposit_instalment(UUID, NUMERIC, DATE, TEXT, TEXT, UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION record_deposit_instalment_paid(UUID, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION record_deposit_payment_for_link(TEXT, TEXT, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION cancel_deposit_instalment(UUID, UUID, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
