-- Pool the security-deposit ledger at the CUSTOMER level, not per
-- deposit_carried_from chain.
--
-- 00500 moved deposit tracking onto contracts and computed balance by
-- walking deposit_carried_from — a chain that only connects RENEWAL
-- contracts. A real customer (Work Booster) surfaced the next gap: they
-- hold TWV-C-0081 (standalone) and TWV-C-0082->TWV-C-0111 (a separate
-- renewal chain) under the same lead_id, but those are two completely
-- disconnected pools today. Business direction: the deposit is a property
-- of the CUSTOMER, who may hold multiple contracts over time; the required
-- amount aggregates from what each contract individually agreed to, the
-- collected amount is drawable against ANY of the customer's contracts,
-- and the consolidated total should be what's shown everywhere.
--
-- Design: don't move the money a second time. It stays recorded on
-- whichever contract actually collected it (the audit-correct place —
-- "this contract's activation brought in ₹Y"). Only the AGGREGATION
-- changes: sum across every contract sharing a lead_id, not just one
-- deposit_carried_from chain. No backfill needed — this is a function-body
-- change over already-correct per-contract data.
--
-- deposit_carried_from / resolve_deposit_source_contract (00359) are left
-- completely alone — they still serve their one non-money purpose (the
-- isRenewal check in contracts/[id]/route.ts that skips the proposal
-- payment gate and the activation snapshot for renewals).
--
-- Two gaps this pooling would otherwise make dangerous, both addressed:
--
-- 1. No refund/return-of-deposit concept exists anywhere in this codebase
--    (contract termination touches zero deposit fields). Once a customer's
--    contracts share one pool, an un-refunded deposit on a terminated
--    contract would inflate every OTHER contract's available balance too,
--    not just its own chain. Fixed with minimal, explicit refund columns
--    (not a full refund workflow — no UI to set them ships in this
--    migration; that's a deliberate fast-follow) so accounts has a lever
--    to flag it when money actually goes back to a customer.
--
-- 2. The old single-row FOR UPDATE lock on one contract no longer
--    serializes access to a pool N contracts can draw from — two
--    concurrent adjustment requests against two different contracts of the
--    same lead could each read a stale total and both pass. Fixed with a
--    Postgres advisory transaction lock keyed by lead_id.

-- ── 1. Refund-tracking columns on contracts (mirror deposit_payment_* typing) ──

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS deposit_refunded_amount DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS deposit_refunded_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_refund_reference TEXT;

-- All nullable; COALESCE(deposit_refunded_amount, 0) at read time means
-- "not refunded" is the safe default — erring toward retaining a claimable
-- balance rather than silently dropping it.


-- ── 2. source_lead_id on deposit_adjustments / deposit_topups ──────────────
--
-- Trivial lookup (contracts.lead_id is NOT NULL) — no chain-walk needed.
-- source_contract_id stays, untouched, informational (same "relax and
-- keep, never drop a financial FK" pattern as 00500 did for
-- source_proposal_id).

ALTER TABLE deposit_adjustments ADD COLUMN IF NOT EXISTS source_lead_id UUID REFERENCES leads(id);
ALTER TABLE deposit_topups      ADD COLUMN IF NOT EXISTS source_lead_id UUID REFERENCES leads(id);

UPDATE deposit_adjustments SET source_lead_id = (SELECT lead_id FROM contracts WHERE id = deposit_adjustments.contract_id)
  WHERE source_lead_id IS NULL;
UPDATE deposit_topups SET source_lead_id = (SELECT lead_id FROM contracts WHERE id = deposit_topups.contract_id)
  WHERE source_lead_id IS NULL;

ALTER TABLE deposit_adjustments ALTER COLUMN source_lead_id SET NOT NULL;
ALTER TABLE deposit_topups ALTER COLUMN source_lead_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deposit_adjustments_source_lead ON deposit_adjustments(source_lead_id);
CREATE INDEX IF NOT EXISTS idx_deposit_topups_source_lead ON deposit_topups(source_lead_id);

-- RLS unchanged: both tables remain wide-open USING (true)/WITH CHECK (true)
-- for authenticated.


-- ── 3. Rewrite the 4 deposit-math functions to pool by lead_id ─────────────

-- Return type gains source_lead_id, so CREATE OR REPLACE won't do (same
-- reason 00500 had to drop-then-create this one).
DROP FUNCTION IF EXISTS get_deposit_available_balance(UUID);

CREATE FUNCTION get_deposit_available_balance(p_contract_id UUID)
RETURNS TABLE(
  source_contract_id UUID,
  source_proposal_id UUID,
  source_lead_id UUID,
  deposit_collected NUMERIC,
  committed NUMERIC,
  available NUMERIC,
  -- NULL when available > 0. Otherwise one of:
  --   no_proposal      — no contract belonging to this customer has ever had a proposal
  --   deposit_pending  — some contract of this customer has a deposit amount on file, unpaid
  --   no_deposit       — nothing was ever collected across any of this customer's contracts
  --   fully_committed  — collected, but already spoken for by other adjustments
  unavailable_reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_contract UUID;
  v_source_proposal_id UUID;
  v_lead_id UUID;
  v_collected NUMERIC;
  v_committed NUMERIC;
  v_available NUMERIC;
  v_has_any_proposal BOOLEAN;
  v_has_pending_deposit BOOLEAN;
BEGIN
  -- Kept for informational/back-compat display only — no longer determines
  -- the pool boundary. resolve_deposit_source_contract still matters for
  -- the unrelated isRenewal gate/snapshot logic in contracts/[id]/route.ts.
  v_source_contract := resolve_deposit_source_contract(p_contract_id);
  SELECT proposal_id INTO v_source_proposal_id FROM contracts WHERE id = v_source_contract;

  SELECT lead_id INTO v_lead_id FROM contracts WHERE id = p_contract_id;

  SELECT COALESCE(SUM(
    GREATEST(
      (CASE WHEN c.deposit_payment_status = 'paid'
         THEN COALESCE(c.deposit_payment_amount, c.security_deposit_amount, 0)
         ELSE 0 END)
      - COALESCE(c.deposit_refunded_amount, 0),
      0
    )
  ), 0)
  INTO v_collected
  FROM contracts c WHERE c.lead_id = v_lead_id;

  v_collected := v_collected + COALESCE((
    SELECT SUM(dt.amount) FROM deposit_topups dt
    WHERE dt.source_lead_id = v_lead_id AND dt.status = 'paid'
  ), 0);

  SELECT COALESCE(SUM(da.amount), 0) INTO v_committed
  FROM deposit_adjustments da
  WHERE da.source_lead_id = v_lead_id
    AND da.status IN ('pending_approval', 'approved');

  v_available := GREATEST(v_collected - v_committed, 0);

  SELECT EXISTS(SELECT 1 FROM contracts WHERE lead_id = v_lead_id AND proposal_id IS NOT NULL)
    INTO v_has_any_proposal;
  SELECT EXISTS(
    SELECT 1 FROM contracts
    WHERE lead_id = v_lead_id
      AND deposit_payment_status IS DISTINCT FROM 'paid'
      AND COALESCE(security_deposit_amount, 0) > 0
  ) INTO v_has_pending_deposit;

  RETURN QUERY SELECT v_source_contract, v_source_proposal_id, v_lead_id, v_collected, v_committed, v_available,
    CASE
      WHEN v_available > 0 THEN NULL
      WHEN v_collected > 0 THEN 'fully_committed'
      WHEN NOT v_has_any_proposal THEN 'no_proposal'
      WHEN v_has_pending_deposit THEN 'deposit_pending'
      ELSE 'no_deposit'
    END::TEXT;
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
  v_source_proposal_id UUID;
  v_lead_id UUID;
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

  SELECT lead_id INTO v_lead_id FROM contracts WHERE id = p_contract_id;

  -- The old single-row FOR UPDATE lock no longer serializes access to a
  -- pool shared by N contracts. An advisory transaction lock keyed by
  -- lead_id closes that race — two concurrent requests against two
  -- different contracts of the same customer now queue instead of both
  -- reading a stale total. Auto-released at transaction end.
  PERFORM pg_advisory_xact_lock(hashtext('deposit_pool:' || v_lead_id::text));

  v_source_contract := resolve_deposit_source_contract(p_contract_id);
  SELECT proposal_id INTO v_source_proposal_id FROM contracts WHERE id = v_source_contract;

  SELECT COALESCE(SUM(
    GREATEST(
      (CASE WHEN c.deposit_payment_status = 'paid'
         THEN COALESCE(c.deposit_payment_amount, c.security_deposit_amount, 0)
         ELSE 0 END)
      - COALESCE(c.deposit_refunded_amount, 0),
      0
    )
  ), 0)
  INTO v_collected
  FROM contracts c WHERE c.lead_id = v_lead_id;

  v_collected := v_collected + COALESCE((
    SELECT SUM(dt.amount) FROM deposit_topups dt
    WHERE dt.source_lead_id = v_lead_id AND dt.status = 'paid'
  ), 0);

  IF v_collected <= 0 THEN
    RETURN QUERY SELECT FALSE, 'No paid deposit found for this contract', NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  SELECT COALESCE(SUM(da.amount), 0) INTO v_committed
  FROM deposit_adjustments da
  WHERE da.source_lead_id = v_lead_id
    AND da.status IN ('pending_approval', 'approved');

  v_available := v_collected - v_committed;

  IF p_amount > v_available + 0.01 THEN
    RETURN QUERY SELECT FALSE,
      format('Amount exceeds available deposit balance (available: %s)', ROUND(v_available, 2)),
      NULL::UUID, v_available;
    RETURN;
  END IF;

  INSERT INTO deposit_adjustments (
    contract_id, source_contract_id, source_proposal_id, source_lead_id, billing_statement_id, amount,
    status, requested_by, notify_customer
  ) VALUES (
    p_contract_id, v_source_contract, v_source_proposal_id, v_lead_id, p_billing_statement_id, p_amount,
    'pending_approval', p_requested_by, COALESCE(p_notify_customer, FALSE)
  ) RETURNING id INTO v_new_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_new_id, (v_available - p_amount);
END;
$$;


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
  v_source_proposal_id UUID;
  v_source_lead_id UUID;
  v_new_id UUID;
  v_shortfall NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN QUERY SELECT FALSE, 'Amount must be greater than zero', NULL::UUID;
    RETURN;
  END IF;

  v_source_contract := resolve_deposit_source_contract(p_contract_id);
  SELECT proposal_id INTO v_source_proposal_id FROM contracts WHERE id = v_source_contract;
  SELECT lead_id INTO v_source_lead_id FROM contracts WHERE id = p_contract_id;

  -- p_applies_to_shortfall stays keyed off p_contract_id's own
  -- deposit_shortfall (a renewal-escalation concept), unaffected by pooling.
  IF p_applies_to_shortfall THEN
    SELECT deposit_shortfall INTO v_shortfall FROM contracts WHERE id = p_contract_id FOR UPDATE;
    UPDATE contracts SET deposit_shortfall = GREATEST(0, COALESCE(v_shortfall, 0) - p_amount)
    WHERE id = p_contract_id;
  END IF;

  INSERT INTO deposit_topups (
    contract_id, source_contract_id, source_proposal_id, source_lead_id, amount, category, category_note,
    status, collection_method, payment_mode, payment_reference, proof_path,
    applies_to_shortfall, created_by, paid_at
  ) VALUES (
    p_contract_id, v_source_contract, v_source_proposal_id, v_source_lead_id, p_amount, p_category, p_category_note,
    'paid', 'manual', p_payment_mode, p_payment_reference, p_proof_path,
    COALESCE(p_applies_to_shortfall, FALSE), p_created_by, NOW()
  ) RETURNING id INTO v_new_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_new_id;
END;
$$;


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
  v_source_proposal_id UUID;
  v_source_lead_id UUID;
  v_new_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN QUERY SELECT FALSE, 'Amount must be greater than zero', NULL::UUID;
    RETURN;
  END IF;

  v_source_contract := resolve_deposit_source_contract(p_contract_id);
  SELECT proposal_id INTO v_source_proposal_id FROM contracts WHERE id = v_source_contract;
  SELECT lead_id INTO v_source_lead_id FROM contracts WHERE id = p_contract_id;

  INSERT INTO deposit_topups (
    contract_id, source_contract_id, source_proposal_id, source_lead_id, amount, category, category_note,
    status, collection_method, razorpay_payment_link_id, razorpay_payment_link_url,
    applies_to_shortfall, created_by
  ) VALUES (
    p_contract_id, v_source_contract, v_source_proposal_id, v_source_lead_id, p_amount, p_category, p_category_note,
    'pending', 'razorpay_link', p_razorpay_link_id, p_razorpay_link_url,
    COALESCE(p_applies_to_shortfall, FALSE), p_created_by
  ) RETURNING id INTO v_new_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_new_id;
END;
$$;

-- mark_deposit_topup_paid, mark_deposit_topup_paid_manual, cancel_deposit_topup,
-- reverse_deposit_topup, approve/reject/reverse_deposit_adjustment are all
-- untouched — none of them compute pool totals; they operate on specific
-- rows by id.


-- ── 4. Audit trigger — extend the contracts-side watched-column list ───────
--
-- Same pattern as 00500: the array inside the function body AND the
-- trigger's own "AFTER UPDATE OF" column list are both hardcoded and must
-- change together.
--
-- log_payment_field_changes() was ALSO redefined by 00430 (merged after
-- 00500, before this migration was written) to add proposals-side manual-
-- payment columns. Since this migration fully replaces the function body
-- again, 00430's proposals additions (payment_medium, payment_screenshot_url,
-- payment_recorded_by, payment_shortfall_approved_by) are carried forward
-- into the proposals branch below verbatim — omitting them would silently
-- regress 00430's audit coverage the moment this migration applies after
-- it. The proposals trigger itself is untouched (00430 already created it
-- with the matching AFTER UPDATE OF list); only the contracts trigger is
-- recreated here.

CREATE OR REPLACE FUNCTION log_payment_field_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  watched_columns TEXT[];
  entity TEXT;
  col TEXT;
  old_row JSONB := to_jsonb(OLD);
  new_row JSONB := to_jsonb(NEW);
  changes JSONB := '{}'::JSONB;
  actor UUID;
  performer_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'proposals' THEN
    entity := 'proposal';
    watched_columns := ARRAY[
      'payment_status', 'payment_amount', 'payment_reference', 'payment_received_at',
      'payment_medium', 'payment_screenshot_url', 'payment_recorded_by',
      'payment_shortfall_approved_by',
      'razorpay_payment_link_id', 'razorpay_payment_link_url',
      'security_deposit_amount', 'security_deposit_months',
      'deposit_payment_status', 'deposit_payment_amount', 'deposit_payment_medium',
      'deposit_payment_reference', 'deposit_payment_received_at', 'deposit_payment_screenshot_url',
      'deposit_razorpay_link_id', 'deposit_razorpay_link_url', 'deposit_shortfall_approved_by',
      'deposit_credit_amount', 'deposit_credit_applied_at', 'deposit_credit_applied_by',
      'deposit_credit_proof_url', 'deposit_credit_reason',
      'deposit_accounted', 'deposit_accounted_at', 'deposit_accounted_by', 'deposit_accounted_proof_path',
      'deposit_waiver_requested_at', 'deposit_waiver_verified_at', 'deposit_waiver_verified_by',
      'deposit_settled_at', 'deposit_settlement_id', 'deposit_due_date'
    ];
  ELSIF TG_TABLE_NAME = 'contracts' THEN
    entity := 'contract';
    watched_columns := ARRAY[
      'deposit_carried_from', 'deposit_shortfall',
      'prorata_payment_status', 'prorata_billing_statement_id',
      'security_deposit_months',
      'security_deposit_amount', 'deposit_payment_status', 'deposit_payment_amount',
      'deposit_payment_reference', 'deposit_payment_medium', 'deposit_payment_received_at',
      'deposit_internal_notes',
      'deposit_refunded_amount', 'deposit_refunded_at', 'deposit_refund_reference'
    ];
  ELSE
    RETURN NEW;
  END IF;

  FOREACH col IN ARRAY watched_columns LOOP
    IF (old_row -> col) IS DISTINCT FROM (new_row -> col) THEN
      changes := changes || jsonb_build_object(col, jsonb_build_object('old', old_row -> col, 'new', new_row -> col));
    END IF;
  END LOOP;

  IF changes = '{}'::JSONB THEN
    RETURN NEW;
  END IF;

  BEGIN
    actor := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    actor := NULL;
  END;

  changes := changes || jsonb_build_object(
    '_db_role', current_user,
    '_db_session_user', session_user
  );

  IF actor IS NOT NULL THEN
    SELECT id INTO performer_id FROM users WHERE auth_id = actor;
  END IF;

  INSERT INTO audit_trail (entity_type, entity_id, action, changes, performed_by)
  VALUES (entity, NEW.id, 'payment_fields_changed', changes, performer_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_contract_payment_changes ON contracts;
CREATE TRIGGER trg_log_contract_payment_changes
  AFTER UPDATE OF
    deposit_carried_from, deposit_shortfall,
    prorata_payment_status, prorata_billing_statement_id,
    security_deposit_months,
    security_deposit_amount, deposit_payment_status, deposit_payment_amount,
    deposit_payment_reference, deposit_payment_medium, deposit_payment_received_at,
    deposit_internal_notes,
    deposit_refunded_amount, deposit_refunded_at, deposit_refund_reference
  ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION log_payment_field_changes();

-- (trg_log_proposal_payment_changes on proposals is untouched.)
