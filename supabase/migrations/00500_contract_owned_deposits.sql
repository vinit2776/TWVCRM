-- Move the security-deposit LEDGER (not the pre-activation collection flow)
-- from proposals to contracts.
--
-- Business direction: the proposal's job is to bridge the commercial gap only
-- until the contract activates — it still collects the deposit and gates
-- activation, unchanged. But once a contract exists, everything after that
-- (top-ups, adjustments, corrections, balance display) should be owned by the
-- contract, matching how pro-rata already works (contracts.is_renewal /
-- prorata_payment_status / prorata_billing_statement_id, zero proposal
-- involvement). Today deposits are the one commercial term still tethered to
-- proposals.proposal_id forever, live, with no snapshot ever taken — which
-- means a contract created without a proposal (legacy import, hand-entered)
-- has nowhere to record a deposit at all, and the contract page's own
-- "Collect Additional Deposit" button fails for it with "No
-- deposit-collecting proposal found for this contract" (see
-- record_deposit_topup_manual / create_deposit_topup_link below, pre-fix).
--
-- Scope: only the 7 fields that the balance math actually keys off
-- (security_deposit_amount, deposit_payment_status, deposit_payment_amount,
-- deposit_payment_reference, deposit_payment_medium, deposit_payment_received_at,
-- deposit_internal_notes). The ~18 other deposit_* fields on proposals
-- (credit, exception, waiver OTP, accounted-for-tax) stay there — those are
-- pre-activation underwriting decisions, not post-activation ledger state.
--
-- resolve_deposit_source_contract (00359) is untouched — it already operates
-- purely on contracts.deposit_carried_from and never touches proposals.

-- ── 1. New contracts columns (mirror proposals' types/defaults exactly:
--    00069_security_deposit.sql, 00217_deposit_payment_medium.sql,
--    00387_deposit_internal_notes.sql) ─────────────────────────────────────

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS security_deposit_amount    DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_payment_status      TEXT DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS deposit_payment_amount      DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS deposit_payment_reference   TEXT,
  ADD COLUMN IF NOT EXISTS deposit_payment_medium      TEXT,
  ADD COLUMN IF NOT EXISTS deposit_payment_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_internal_notes      TEXT;

-- Note: contracts.security_deposit_months already exists (00007), populated
-- at draft-creation from user input, not guaranteed to match the proposal's
-- final value — the activation snapshot (app-layer change, contracts/[id]/route.ts)
-- and the backfill below (§4) both overwrite it too, so it becomes
-- authoritative post-activation.


-- ── 2. deposit_adjustments / deposit_topups: add source_contract_id,
--    relax source_proposal_id ──────────────────────────────────────────────
--
-- Both tables keyed their balance math off source_proposal_id (NOT NULL FK
-- to proposals) — used to FOR UPDATE-lock the balance-holding row and to sum
-- across a renewal chain. The grouping key becomes the resolved source
-- CONTRACT id. source_proposal_id is relaxed (not dropped) — existing rows
-- carry real history worth keeping, and dropping a NOT NULL FK is a needless
-- one-way door; going forward it's populated for informational/back-compat
-- purposes only and no longer read by any balance/lock logic.

ALTER TABLE deposit_adjustments
  ALTER COLUMN source_proposal_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_contract_id UUID REFERENCES contracts(id) ON DELETE RESTRICT;

ALTER TABLE deposit_topups
  ALTER COLUMN source_proposal_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_contract_id UUID REFERENCES contracts(id) ON DELETE RESTRICT;

UPDATE deposit_adjustments SET source_contract_id = resolve_deposit_source_contract(contract_id)
  WHERE source_contract_id IS NULL;
UPDATE deposit_topups SET source_contract_id = resolve_deposit_source_contract(contract_id)
  WHERE source_contract_id IS NULL;

ALTER TABLE deposit_adjustments ALTER COLUMN source_contract_id SET NOT NULL;
ALTER TABLE deposit_topups ALTER COLUMN source_contract_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deposit_adjustments_source_contract ON deposit_adjustments(source_contract_id);
CREATE INDEX IF NOT EXISTS idx_deposit_topups_source_contract ON deposit_topups(source_contract_id);

-- RLS unchanged: both tables are wide-open USING (true)/WITH CHECK (true)
-- for authenticated — role gating lives in the RPCs, not in policy
-- predicates, so relaxing/adding a column here needs no policy change.


-- ── 3. Relocate the 4 deposit-math functions to read/write via the
--    resolved source CONTRACT instead of joining proposals. Same
--    signatures/return shapes as before — every existing caller (top-up UI,
--    adjustment UI, the deposit-balance API route) keeps working unchanged.
--    Every "no proposal → error" branch is deleted: a contract's own
--    deposit columns are always readable regardless of whether it ever had
--    a proposal_id. ──────────────────────────────────────────────────────
--
-- get_deposit_available_balance and request_deposit_adjustment also fold in
-- an unreleased fix (branch fix/deposit-adjustment-visibility, migration
-- 00427_deposit_balance_reason_and_topup_fixes.sql, applied to this same
-- database out-of-band while this migration was being written): an
-- unavailable_reason column so the UI can explain a zero balance instead of
-- silently hiding the option, plus two real bugs in the "deposit not paid,
-- but top-ups exist" branch — v_collected was including the proposal's
-- *uncollected* required amount as if it were in hand, and the read path
-- skipped checking committed adjustments entirely in that branch. Both are
-- fixed here too (adapted to read the contract's own columns), so this
-- migration doesn't regress that fix. unavailable_reason keeps its original
-- four values; 'no_proposal' now means "the resolved source contract's own
-- proposal_id is NULL" rather than requiring a live proposal join.

DROP FUNCTION IF EXISTS get_deposit_available_balance(UUID);

CREATE FUNCTION get_deposit_available_balance(p_contract_id UUID)
RETURNS TABLE(
  source_contract_id UUID,
  source_proposal_id UUID,
  deposit_collected NUMERIC,
  committed NUMERIC,
  available NUMERIC,
  -- NULL when available > 0. Otherwise one of:
  --   no_proposal      — the source contract has no proposal_id on file
  --   deposit_pending  — a deposit amount is on file, not yet paid
  --   no_deposit       — nothing was ever collected (waived / zero deposit)
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
  v_deposit_status TEXT;
  v_deposit_amount NUMERIC;
  v_deposit_paid_amount NUMERIC;
  v_topups NUMERIC;
  v_collected NUMERIC;
  v_committed NUMERIC;
  v_available NUMERIC;
BEGIN
  v_source_contract := resolve_deposit_source_contract(p_contract_id);

  SELECT deposit_payment_status, security_deposit_amount, deposit_payment_amount, proposal_id
  INTO v_deposit_status, v_deposit_amount, v_deposit_paid_amount, v_source_proposal_id
  FROM contracts WHERE id = v_source_contract;

  SELECT COALESCE(SUM(dt.amount), 0) INTO v_topups
  FROM deposit_topups dt
  WHERE dt.source_contract_id = v_source_contract AND dt.status = 'paid';

  -- The contract's own deposit counts only once it is actually marked paid.
  -- Top-ups are already money in hand, so they count regardless — a
  -- risk-buffer top-up on a contract whose deposit was waived is adjustable.
  v_collected := CASE
    WHEN v_deposit_status = 'paid' THEN COALESCE(v_deposit_paid_amount, v_deposit_amount, 0)
    ELSE 0
  END + v_topups;

  SELECT COALESCE(SUM(da.amount), 0) INTO v_committed
  FROM deposit_adjustments da
  WHERE da.source_contract_id = v_source_contract
    AND da.status IN ('pending_approval', 'approved');

  v_available := GREATEST(v_collected - v_committed, 0);

  RETURN QUERY SELECT v_source_contract, v_source_proposal_id, v_collected, v_committed, v_available,
    CASE
      WHEN v_available > 0 THEN NULL
      WHEN v_collected > 0 THEN 'fully_committed'
      WHEN v_source_proposal_id IS NULL THEN 'no_proposal'
      WHEN v_deposit_status IS DISTINCT FROM 'paid' AND COALESCE(v_deposit_amount, 0) > 0
        THEN 'deposit_pending'
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

  -- Lock the source CONTRACT row (not a proposal) for the duration of the
  -- balance check + insert.
  SELECT deposit_payment_status, security_deposit_amount, deposit_payment_amount, proposal_id
  INTO v_deposit_status, v_deposit_amount, v_deposit_paid_amount, v_source_proposal_id
  FROM contracts WHERE id = v_source_contract
  FOR UPDATE;

  SELECT COALESCE(SUM(dt.amount), 0) INTO v_topups
  FROM deposit_topups dt
  WHERE dt.source_contract_id = v_source_contract AND dt.status = 'paid';

  -- Same rule as get_deposit_available_balance: the contract's own deposit
  -- counts only once it's actually paid, never its required-but-uncollected
  -- amount (that was the write-path half of the bug this migration folds in).
  v_collected := CASE
    WHEN v_deposit_status = 'paid' THEN COALESCE(v_deposit_paid_amount, v_deposit_amount, 0)
    ELSE 0
  END + v_topups;

  IF v_collected <= 0 THEN
    RETURN QUERY SELECT FALSE, 'No paid deposit found for this contract', NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  SELECT COALESCE(SUM(da.amount), 0) INTO v_committed
  FROM deposit_adjustments da
  WHERE da.source_contract_id = v_source_contract
    AND da.status IN ('pending_approval', 'approved');

  v_available := v_collected - v_committed;

  IF p_amount > v_available + 0.01 THEN
    RETURN QUERY SELECT FALSE,
      format('Amount exceeds available deposit balance (available: %s)', ROUND(v_available, 2)),
      NULL::UUID, v_available;
    RETURN;
  END IF;

  INSERT INTO deposit_adjustments (
    contract_id, source_contract_id, source_proposal_id, billing_statement_id, amount,
    status, requested_by, notify_customer
  ) VALUES (
    p_contract_id, v_source_contract, v_source_proposal_id, p_billing_statement_id, p_amount,
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
  v_new_id UUID;
  v_shortfall NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN QUERY SELECT FALSE, 'Amount must be greater than zero', NULL::UUID;
    RETURN;
  END IF;

  v_source_contract := resolve_deposit_source_contract(p_contract_id);
  -- The contract itself is always a valid deposit source now — no proposal
  -- existence check. source_proposal_id is carried along for informational
  -- back-compat only, nullable.
  SELECT proposal_id INTO v_source_proposal_id FROM contracts WHERE id = v_source_contract;

  IF p_applies_to_shortfall THEN
    SELECT deposit_shortfall INTO v_shortfall FROM contracts WHERE id = p_contract_id FOR UPDATE;
    UPDATE contracts SET deposit_shortfall = GREATEST(0, COALESCE(v_shortfall, 0) - p_amount)
    WHERE id = p_contract_id;
  END IF;

  INSERT INTO deposit_topups (
    contract_id, source_contract_id, source_proposal_id, amount, category, category_note,
    status, collection_method, payment_mode, payment_reference, proof_path,
    applies_to_shortfall, created_by, paid_at
  ) VALUES (
    p_contract_id, v_source_contract, v_source_proposal_id, p_amount, p_category, p_category_note,
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
  v_new_id UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN QUERY SELECT FALSE, 'Amount must be greater than zero', NULL::UUID;
    RETURN;
  END IF;

  v_source_contract := resolve_deposit_source_contract(p_contract_id);
  SELECT proposal_id INTO v_source_proposal_id FROM contracts WHERE id = v_source_contract;

  INSERT INTO deposit_topups (
    contract_id, source_contract_id, source_proposal_id, amount, category, category_note,
    status, collection_method, razorpay_payment_link_id, razorpay_payment_link_url,
    applies_to_shortfall, created_by
  ) VALUES (
    p_contract_id, v_source_contract, v_source_proposal_id, p_amount, p_category, p_category_note,
    'pending', 'razorpay_link', p_razorpay_link_id, p_razorpay_link_url,
    COALESCE(p_applies_to_shortfall, FALSE), p_created_by
  ) RETURNING id INTO v_new_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_new_id;
END;
$$;

-- mark_deposit_topup_paid, mark_deposit_topup_paid_manual, cancel_deposit_topup,
-- reverse_deposit_topup, approve/reject/reverse_deposit_adjustment are all
-- untouched — none of them read or write proposals; they operate on
-- deposit_topups/deposit_adjustments/contracts.deposit_shortfall directly.


-- ── 4. Audit trigger — extend the contracts-side watched-column list
--    (00384_deposit_payment_audit_trigger.sql). Both the array inside the
--    function body AND the trigger's own "AFTER UPDATE OF" column list are
--    hardcoded and must change together — Postgres can't introspect this.
--    The proposals side is untouched: those 7 fields stay watched there too,
--    since pre-activation writes still happen on proposals. ─────────────────

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
      'deposit_internal_notes'
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
    deposit_internal_notes
  ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION log_payment_field_changes();

-- (trg_log_proposal_payment_changes on proposals is untouched — not redefined here.)


-- ── 5. Historical backfill — atomic with the cutover above. For every
--    contract that is (or is the resolved root of) a currently live
--    active/renewed/renewal_in_progress contract, copy its own linked
--    proposal's 7 fields onto its own new columns. Mirrors exactly what the
--    activation-time snapshot (app-layer change) does going forward, so no
--    contract regresses to a worse state than today. ────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT resolve_deposit_source_contract(c.id) AS source_id
    FROM contracts c
    WHERE c.status IN ('active', 'renewed', 'renewal_in_progress')
  LOOP
    UPDATE contracts target SET
      security_deposit_amount     = p.security_deposit_amount,
      deposit_payment_status      = p.deposit_payment_status,
      deposit_payment_amount      = p.deposit_payment_amount,
      deposit_payment_reference   = p.deposit_payment_reference,
      deposit_payment_medium      = p.deposit_payment_medium,
      deposit_payment_received_at = p.deposit_payment_received_at,
      deposit_internal_notes      = p.deposit_internal_notes,
      security_deposit_months     = COALESCE(p.security_deposit_months, target.security_deposit_months)
    FROM proposals p
    WHERE target.id = r.source_id AND target.proposal_id = p.id;
    -- Source contracts with proposal_id IS NULL (legacy/hand-entered) simply
    -- keep the column defaults (0 / 'not_required') — nothing to copy, which
    -- matches today's actual state exactly (they have no deposit record
    -- today either; this migration relocates real data, it doesn't invent any).
  END LOOP;
END $$;
