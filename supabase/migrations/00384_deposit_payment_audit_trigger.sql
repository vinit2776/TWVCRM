-- Backstop audit logging for deposit/payment fields on proposals and contracts.
--
-- Context: TWV-C-0083's proposal had deposit_payment_status flipped to "paid"
-- directly against the database (no Razorpay webhook hit, no manual-payment API
-- call — amount/reference/medium/received_at all stayed NULL), leaving zero trace
-- of who did it or when. Application-level logAudit() calls (see src/lib/audit.ts)
-- can never catch a write that skips the app entirely — a Postgres trigger is the
-- only mechanism that observes every UPDATE regardless of how it was issued
-- (API route, webhook, cron, Supabase SQL editor, or a script with the service
-- role key).
--
-- This does not replace the app-level logAudit() calls already added to the
-- Razorpay webhook and the manual deposit-payment route — those capture *who*
-- (a real user id) and *why* (request context) a change happened. This trigger
-- is the safety net that guarantees *that* it happened, even when the app-level
-- call is missing, buggy, or bypassed. Entries it writes use a distinct action
-- ("payment_fields_changed") so they're easy to tell apart from app-authored
-- "update" rows, and performed_by is populated from auth.uid() only when the
-- write happened through PostgREST with a user session — direct SQL/dashboard
-- edits and service-role writes leave it NULL, with the raw Postgres role
-- recorded in the changes payload for forensics.

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

DROP TRIGGER IF EXISTS trg_log_proposal_payment_changes ON proposals;
CREATE TRIGGER trg_log_proposal_payment_changes
  AFTER UPDATE OF
    payment_status, payment_amount, payment_reference, payment_received_at,
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

DROP TRIGGER IF EXISTS trg_log_contract_payment_changes ON contracts;
CREATE TRIGGER trg_log_contract_payment_changes
  AFTER UPDATE OF
    deposit_carried_from, deposit_shortfall,
    prorata_payment_status, prorata_billing_statement_id,
    security_deposit_months
  ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION log_payment_field_changes();
