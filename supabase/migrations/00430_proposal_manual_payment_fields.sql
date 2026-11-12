-- Manual recording of a proposal's monthly / pro-rata first-invoice payment.
--
-- proposals.payment_status has only ever been flipped to 'paid' by the Razorpay
-- webhook (/api/payments/webhook) or /api/payments/verify. The security deposit
-- has had a full manual path for a long time — POST /api/proposals/[id]/deposit-payment
-- with amount, medium, reference, proof and an internal note — but the monthly
-- charge never got one. So a customer who pays the first invoice by NEFT leaves
-- the proposal stuck on 'pending', and the contract activation gate has no exit
-- except the admin payment override.
--
-- That is the gap behind TWV-C-0121: its deposit was recorded manually from a
-- NEFT transfer, while the monthly charge sat pending because there was nowhere
-- to record the same kind of transfer against it.
--
-- These columns mirror the deposit_* set one-for-one so both payment paths carry
-- the same evidence. Extending 00384's coverage to them is the point, not an
-- afterthought: that trigger is the backstop that caught TWV-C-0083's
-- untraceable deposit flip, and a manual payment path outside its watch would
-- reintroduce exactly that blind spot. Both the function's watched_columns array
-- AND the trigger's own AFTER UPDATE OF list need the new columns — the latter
-- decides whether the function is invoked at all.
--
-- Rollback:
--   ALTER TABLE proposals
--     DROP COLUMN IF EXISTS payment_shortfall_approved_by,
--     DROP COLUMN IF EXISTS payment_recorded_by,
--     DROP COLUMN IF EXISTS payment_internal_notes,
--     DROP COLUMN IF EXISTS payment_screenshot_url,
--     DROP COLUMN IF EXISTS payment_medium;
--   -- then re-run 00384 verbatim to restore the previous function + trigger.

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS payment_medium TEXT,
  ADD COLUMN IF NOT EXISTS payment_screenshot_url TEXT,
  ADD COLUMN IF NOT EXISTS payment_internal_notes TEXT,
  ADD COLUMN IF NOT EXISTS payment_recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_shortfall_approved_by UUID REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN proposals.payment_medium IS
  'How the monthly / pro-rata payment arrived: neft | rtgs | upi | cheque | cash | razorpay. '
  'Set by the manual route; Razorpay-collected payments use payment_mode instead.';

COMMENT ON COLUMN proposals.payment_recorded_by IS
  'User who manually recorded this payment. NULL when the Razorpay webhook set it.';

-- Function body is 00384's, verbatim, with the five new columns added to the
-- proposals watched_columns array and nothing else changed.
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
      'security_deposit_months'
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

  -- Only resolves when the write came through PostgREST with a user JWT.
  -- Direct SQL/dashboard edits and service-role writes have no auth.uid().
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

-- Recreate the proposals trigger so the new columns are in its AFTER UPDATE OF
-- list. Without this a write touching only (say) payment_medium would never
-- invoke the function. The contracts trigger is unchanged and left alone.
DROP TRIGGER IF EXISTS trg_log_proposal_payment_changes ON proposals;
CREATE TRIGGER trg_log_proposal_payment_changes
  AFTER UPDATE OF
    payment_status, payment_amount, payment_reference, payment_received_at,
    payment_medium, payment_screenshot_url, payment_recorded_by,
    payment_shortfall_approved_by,
    razorpay_payment_link_id, razorpay_payment_link_url,
    security_deposit_amount, security_deposit_months,
    deposit_payment_status, deposit_payment_amount, deposit_payment_medium,
    deposit_payment_reference, deposit_payment_received_at, deposit_payment_screenshot_url,
    deposit_razorpay_link_id, deposit_razorpay_link_url, deposit_shortfall_approved_by,
    deposit_credit_amount, deposit_credit_applied_at, deposit_credit_applied_by,
    deposit_credit_proof_url, deposit_credit_reason,
    deposit_accounted, deposit_accounted_at, deposit_accounted_by, deposit_accounted_proof_path,
    deposit_waiver_requested_at, deposit_waiver_verified_at, deposit_waiver_verified_by,
    deposit_settled_at, deposit_settlement_id, deposit_due_date
  ON proposals
  FOR EACH ROW
  EXECUTE FUNCTION log_payment_field_changes();
