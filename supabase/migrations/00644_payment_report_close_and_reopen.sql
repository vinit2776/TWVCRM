-- Recording a customer payment closes the payment report it satisfies, and
-- reversing that payment reopens the report.
--
-- Until now a payment report and the payment accounts recorded for it were two
-- unrelated records: recording from Receivables or Billing left the report open
-- (29 sat that way on 2026-10-27) and only the report card's own button closed
-- it. The route now picks the report a payment settles (match rule in
-- src/lib/queries/payment-reports.ts) and calls close_payment_report here, so
-- the report, its history line and its thread change together or not at all.
--
-- Reopening is a trigger on billing_payments, not a change to
-- reverse_billing_payment: any path that deletes a payment (the admin reversal,
-- a deposit-adjustment reversal) must reopen a report that was verified against
-- it. Without this the DELETE would trip the verified-has-a-payment CHECK, and
-- the ON DELETE SET NULL on query_payment_reports.billing_payment_id could never
-- leave a verified report behind.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_reopen_reports_on_payment_delete ON billing_payments;
--   DROP FUNCTION IF EXISTS reopen_payment_reports_on_payment_delete();
--   DROP FUNCTION IF EXISTS close_payment_report(UUID, UUID, UUID);
-- Reports already closed by this function keep their verified state.

CREATE OR REPLACE FUNCTION close_payment_report(
  p_report_id  UUID,
  p_payment_id UUID,
  p_actor      UUID
)
RETURNS TABLE(report_id UUID, query_id UUID, reported_by UUID, entity_type TEXT, entity_id UUID)
LANGUAGE plpgsql AS $$
DECLARE
  v_report query_payment_reports%ROWTYPE;
  v_pay    billing_payments%ROWTYPE;
  v_name   TEXT;
BEGIN
  SELECT * INTO v_pay FROM billing_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- A payment settles one report.
  IF EXISTS (
    SELECT 1 FROM query_payment_reports r
     WHERE r.billing_payment_id = p_payment_id AND r.status = 'verified'
  ) THEN
    RETURN;
  END IF;

  -- Another request closing the same report wins; this one does nothing.
  SELECT * INTO v_report FROM query_payment_reports
   WHERE id = p_report_id
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_report.status <> 'reported'
     OR v_report.target_kind <> 'invoice'
     OR v_report.claimed_statement_id IS DISTINCT FROM v_pay.billing_statement_id THEN
    RETURN;
  END IF;

  SELECT full_name INTO v_name FROM users WHERE id = p_actor;

  UPDATE query_payment_reports
     SET status = 'verified',
         billing_payment_id = p_payment_id,
         resolution_note = NULL,
         reviewed_by = p_actor,
         reviewed_at = now()
   WHERE id = v_report.id;

  INSERT INTO query_messages (query_id, event_type, body, created_by)
  VALUES (
    v_report.query_id,
    'payment_verified',
    'Payment recorded on the invoice by ' || COALESCE(v_name, 'accounts') || '; report closed.',
    p_actor
  );

  UPDATE queries
     SET status = 'resolved', resolved_by = p_actor, resolved_at = now(), escalated_at = NULL
   WHERE id = v_report.query_id;

  RETURN QUERY
    SELECT v_report.id, q.id, v_report.created_by, q.entity_type, q.entity_id
      FROM queries q WHERE q.id = v_report.query_id;
END;
$$;

REVOKE ALL ON FUNCTION close_payment_report(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_payment_report(UUID, UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION reopen_payment_reports_on_payment_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_rep RECORD;
BEGIN
  FOR v_rep IN
    SELECT id, query_id, reviewed_by, created_by
      FROM query_payment_reports
     WHERE billing_payment_id = OLD.id AND status = 'verified'
     FOR UPDATE
  LOOP
    UPDATE query_payment_reports
       SET status = 'reported', billing_payment_id = NULL,
           reviewed_by = NULL, reviewed_at = NULL, resolution_note = NULL
     WHERE id = v_rep.id;

    UPDATE queries
       SET status = 'open', resolved_by = NULL, resolved_at = NULL, escalated_at = NULL
     WHERE id = v_rep.query_id;

    INSERT INTO query_messages (query_id, event_type, body, created_by)
    VALUES (
      v_rep.query_id,
      'reopened',
      'The payment this report was verified against was reversed, so the report is open again.',
      COALESCE(v_rep.reviewed_by, v_rep.created_by)
    );
  END LOOP;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_reopen_reports_on_payment_delete ON billing_payments;
CREATE TRIGGER trg_reopen_reports_on_payment_delete
  BEFORE DELETE ON billing_payments
  FOR EACH ROW EXECUTE FUNCTION reopen_payment_reports_on_payment_delete();

NOTIFY pgrst, 'reload schema';
