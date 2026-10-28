-- A payment report stays open only while what accounts has recorded is less
-- than what was reported.
--
-- 00644 closed a report when one recorded payment equalled the reported
-- amount. The rule accounts actually works to is "recorded in full means
-- verified": a bigger payment, or payments made in parts that add up, satisfy
-- the report too, and only a partial payment leaves it open. This replaces the
-- equality match with a coverage test, kept in one place (SQL) so the live
-- close, the one-off sweep and the reopen-on-reversal below cannot disagree.
--
-- Coverage: the credit recorded on the invoice (cash + TDS, every payment
-- including deposit adjustments) minus the amount of reports already verified
-- on that invoice must reach the reported amount, within one rupee. Verified
-- reports are subtracted so two reports for the same money cannot both be
-- satisfied by it.
--
-- Which statement a report is about: the invoice it names, or the statement
-- itself when it was filed from one.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS sweep_covered_payment_reports(UUID, BOOLEAN);
--   DROP FUNCTION IF EXISTS close_covered_payment_report(UUID, UUID);
--   DROP FUNCTION IF EXISTS report_statement_id(UUID, TEXT, UUID);
--   then restore reopen_payment_reports_on_payment_delete() from 00644.

CREATE OR REPLACE FUNCTION report_statement_id(
  p_claimed_statement_id UUID, p_entity_type TEXT, p_entity_id UUID
) RETURNS UUID
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_claimed_statement_id, CASE WHEN p_entity_type = 'billing_statement' THEN p_entity_id END)
$$;

-- Credit on an invoice not yet spoken for by a verified report.
CREATE OR REPLACE FUNCTION statement_unallocated_credit(p_statement_id UUID)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
           SELECT SUM(bp.amount + COALESCE(bp.tds_amount, 0))
             FROM billing_payments bp WHERE bp.billing_statement_id = p_statement_id
         ), 0)
       - COALESCE((
           SELECT SUM(r.amount)
             FROM query_payment_reports r JOIN queries q ON q.id = r.query_id
            WHERE r.status = 'verified' AND r.target_kind = 'invoice'
              AND report_statement_id(r.claimed_statement_id, q.entity_type, q.entity_id) = p_statement_id
         ), 0)
$$;

-- Accounts just recorded p_payment_id: close the oldest open report on its
-- invoice that the recorded credit now covers. One payment closes one report.
CREATE OR REPLACE FUNCTION close_covered_payment_report(p_payment_id UUID, p_actor UUID)
RETURNS TABLE(report_id UUID, query_id UUID, reported_by UUID, entity_type TEXT, entity_id UUID)
LANGUAGE plpgsql AS $$
DECLARE
  v_pay   billing_payments%ROWTYPE;
  v_avail NUMERIC;
  v_rid   UUID;
BEGIN
  SELECT * INTO v_pay FROM billing_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_pay.payment_mode IN ('deposit_adjustment', 'razorpay') OR v_pay.razorpay_payment_id IS NOT NULL THEN
    RETURN;
  END IF;

  -- Serialises with other payments and closes on the same invoice.
  PERFORM 1 FROM billing_statements WHERE id = v_pay.billing_statement_id FOR UPDATE;

  v_avail := statement_unallocated_credit(v_pay.billing_statement_id);

  SELECT r.id INTO v_rid
    FROM query_payment_reports r JOIN queries q ON q.id = r.query_id
   WHERE r.status = 'reported' AND r.target_kind = 'invoice'
     AND report_statement_id(r.claimed_statement_id, q.entity_type, q.entity_id) = v_pay.billing_statement_id
     AND r.amount <= v_avail + 1
   ORDER BY r.created_at, r.id
   LIMIT 1;
  IF v_rid IS NULL THEN RETURN; END IF;

  -- close_payment_report (00644) still insists the report names this invoice
  -- via claimed_statement_id; a statement-filed report may not carry it.
  UPDATE query_payment_reports SET claimed_statement_id = v_pay.billing_statement_id
   WHERE id = v_rid AND claimed_statement_id IS NULL;

  RETURN QUERY SELECT * FROM close_payment_report(v_rid, p_payment_id, p_actor);
END;
$$;

-- One-off clean-up of reports the recorded credit already covers. Dry run by
-- default: it only lists. With p_dry_run = FALSE it closes each report against
-- the latest recorded bank payment on its invoice that no report is linked to.
CREATE OR REPLACE FUNCTION sweep_covered_payment_reports(p_actor UUID, p_dry_run BOOLEAN DEFAULT TRUE)
RETURNS TABLE(report_id UUID, statement_id UUID, reported_amount NUMERIC, available_credit NUMERIC, outcome TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  r        RECORD;
  v_avail  NUMERIC;
  v_used   NUMERIC;
  v_pay    UUID;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _sweep_used (sid UUID PRIMARY KEY, used NUMERIC) ON COMMIT DROP;
  TRUNCATE _sweep_used;

  FOR r IN
    SELECT rp.id, rp.amount, report_statement_id(rp.claimed_statement_id, q.entity_type, q.entity_id) AS sid
      FROM query_payment_reports rp JOIN queries q ON q.id = rp.query_id
     WHERE rp.status = 'reported' AND rp.target_kind = 'invoice'
     ORDER BY rp.created_at, rp.id
  LOOP
    CONTINUE WHEN r.sid IS NULL;
    SELECT COALESCE(u.used, 0) INTO v_used FROM _sweep_used u WHERE u.sid = r.sid;
    v_used := COALESCE(v_used, 0);
    v_avail := statement_unallocated_credit(r.sid) - v_used;

    report_id := r.id; statement_id := r.sid; reported_amount := r.amount; available_credit := v_avail;

    IF r.amount > v_avail + 1 THEN
      outcome := 'stays open (recorded credit is less than reported)';
      RETURN NEXT; CONTINUE;
    END IF;

    SELECT bp.id INTO v_pay FROM billing_payments bp
     WHERE bp.billing_statement_id = r.sid
       AND bp.payment_mode NOT IN ('deposit_adjustment', 'razorpay') AND bp.razorpay_payment_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM query_payment_reports x WHERE x.billing_payment_id = bp.id AND x.status = 'verified')
     ORDER BY bp.created_at DESC LIMIT 1;

    IF v_pay IS NULL THEN
      outcome := 'covered, but no unlinked bank payment to attach it to (use the card)';
      RETURN NEXT; CONTINUE;
    END IF;

    IF p_dry_run THEN
      outcome := 'would close';
      -- A dry run closes nothing, so count what it would use here; a real run
      -- sees its own closes through statement_unallocated_credit.
      INSERT INTO _sweep_used (sid, used) VALUES (r.sid, r.amount)
        ON CONFLICT (sid) DO UPDATE SET used = _sweep_used.used + EXCLUDED.used;
    ELSE
      UPDATE query_payment_reports SET claimed_statement_id = r.sid WHERE id = r.id AND claimed_statement_id IS NULL;
      PERFORM close_payment_report(r.id, v_pay, p_actor);
      outcome := 'closed';
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Reversal: reopen the report linked to the deleted payment (as in 00644), and
-- any further report the remaining credit no longer covers, newest first. Only
-- when the invoice was consistent before the delete, so a report verified by
-- hand for less than its amount is not reopened by an unrelated reversal.
CREATE OR REPLACE FUNCTION reopen_payment_reports_on_payment_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_rep     RECORD;
  v_before  NUMERIC;
  v_after   NUMERIC;
  v_alloc   NUMERIC;
  v_was_ok  BOOLEAN;
BEGIN
  SELECT COALESCE(SUM(bp.amount + COALESCE(bp.tds_amount, 0)), 0) INTO v_before
    FROM billing_payments bp WHERE bp.billing_statement_id = OLD.billing_statement_id;
  v_after := v_before - (OLD.amount + COALESCE(OLD.tds_amount, 0));

  SELECT COALESCE(SUM(r.amount), 0) INTO v_alloc
    FROM query_payment_reports r JOIN queries q ON q.id = r.query_id
   WHERE r.status = 'verified' AND r.target_kind = 'invoice'
     AND report_statement_id(r.claimed_statement_id, q.entity_type, q.entity_id) = OLD.billing_statement_id;
  v_was_ok := v_alloc - 1 <= v_before;

  -- The report linked to this very payment.
  FOR v_rep IN
    SELECT id, query_id, amount, reviewed_by, created_by
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
    VALUES (v_rep.query_id, 'reopened',
            'The payment this report was verified against was reversed, so the report is open again.',
            COALESCE(v_rep.reviewed_by, v_rep.created_by));
    v_alloc := v_alloc - v_rep.amount;
  END LOOP;

  -- Reports the remaining credit no longer covers.
  IF v_was_ok THEN
    FOR v_rep IN
      SELECT r.id, r.query_id, r.amount, r.reviewed_by, r.created_by
        FROM query_payment_reports r JOIN queries q ON q.id = r.query_id
       WHERE r.status = 'verified' AND r.target_kind = 'invoice'
         AND report_statement_id(r.claimed_statement_id, q.entity_type, q.entity_id) = OLD.billing_statement_id
       ORDER BY r.reviewed_at DESC NULLS LAST
       FOR UPDATE OF r
    LOOP
      EXIT WHEN v_alloc - 1 <= v_after;
      UPDATE query_payment_reports
         SET status = 'reported', billing_payment_id = NULL,
             reviewed_by = NULL, reviewed_at = NULL, resolution_note = NULL
       WHERE id = v_rep.id;
      UPDATE queries
         SET status = 'open', resolved_by = NULL, resolved_at = NULL, escalated_at = NULL
       WHERE id = v_rep.query_id;
      INSERT INTO query_messages (query_id, event_type, body, created_by)
      VALUES (v_rep.query_id, 'reopened',
              'A payment on the invoice was reversed, so what is recorded no longer covers this report. It is open again.',
              COALESCE(v_rep.reviewed_by, v_rep.created_by));
      v_alloc := v_alloc - v_rep.amount;
    END LOOP;
  END IF;

  RETURN OLD;
END;
$$;

-- Server-only, like 00645: Supabase's default privileges would otherwise let
-- anon and authenticated call these through PostgREST.
REVOKE ALL ON FUNCTION close_covered_payment_report(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sweep_covered_payment_reports(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION statement_unallocated_credit(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION close_covered_payment_report(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION sweep_covered_payment_reports(UUID, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION statement_unallocated_credit(UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
