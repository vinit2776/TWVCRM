-- A payment report is satisfied by NEW money.
--
-- A payment accounts records with no report is already part of the receivable:
-- it reduces what is owed. A report is a claim about one part ("3,000 more has
-- arrived"), and accounts only confirms that part, not whether the invoice is
-- fully paid. So the credit that can close an open report R on invoice S is
-- only what was recorded on S after R was filed:
--   * payments with created_at >= R.created_at (cash + TDS; a deposit
--     adjustment approved after filing counts as credit but never triggers a
--     close);
--   * minus what older reports on S already used (older reports claim first, so
--     the same money is never counted twice).
-- R closes when that credit reaches the reported amount, within one rupee. An
-- overpayment closes it; less leaves it open. Payments recorded before the
-- report was filed do not close it by themselves.
--
--   invoice 20,000; 15,000 recorded earlier with no report; a 3,000 report:
--   a later payment of 100 leaves it open; 3,000 (or 2,000 then 1,000) closes it.
--
-- Trigger: accounts/admin recording a bank or cash payment (close_covered_payment_report).
-- Deposit adjustments and gateway payments never trigger a close.
--
-- Reversal: a report reopens when the payment it is linked to is reversed, or
-- when reversing a payment drops the new money that closed it below its amount.
-- Only when it was satisfied before the reversal, so a report closed some other
-- way (a legacy sweep, the card's Confirm button) is not reopened by an
-- unrelated reversal.
--
-- Legacy: a report filed after a payment was already recorded is closed with the
-- card's Confirm button, or by sweep_covered_payment_reports. The sweep is an
-- explicit one-time clean-up and deliberately keeps the old basis (credit
-- regardless of date, as in 00646); it is re-stated below only to say so.
--
-- Rollback: re-run close_covered_payment_report, reopen_payment_reports_on_payment_delete
-- and sweep_covered_payment_reports from 00646, then
--   DROP FUNCTION IF EXISTS report_post_filing_credit(UUID, UUID);

-- Credit available to report p_report_id from payments recorded since it was
-- filed, after the reports filed before it have taken what they used.
-- p_exclude_payment lets the reversal trigger ask "and without this payment?".
CREATE OR REPLACE FUNCTION report_post_filing_credit(p_report_id UUID, p_exclude_payment UUID DEFAULT NULL)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_sid   UUID;
  v_filed TIMESTAMPTZ;
  pts     TIMESTAMPTZ[];
  prem    NUMERIC[];
  n       INT;
  i       INT;
  need    NUMERIC;
  take    NUMERIC;
  total   NUMERIC := 0;
  v       RECORD;
BEGIN
  SELECT report_statement_id(r.claimed_statement_id, q.entity_type, q.entity_id), r.created_at
    INTO v_sid, v_filed
    FROM query_payment_reports r JOIN queries q ON q.id = r.query_id
   WHERE r.id = p_report_id;
  IF v_sid IS NULL THEN RETURN 0; END IF;

  SELECT array_agg(bp.created_at ORDER BY bp.created_at, bp.id),
         array_agg(bp.amount + COALESCE(bp.tds_amount, 0) ORDER BY bp.created_at, bp.id)
    INTO pts, prem
    FROM billing_payments bp
   WHERE bp.billing_statement_id = v_sid AND bp.id IS DISTINCT FROM p_exclude_payment;
  n := COALESCE(array_length(pts, 1), 0);
  IF n = 0 THEN RETURN 0; END IF;

  -- Older verified reports claim first, each from the money recorded since it
  -- was filed, earliest payment first.
  FOR v IN
    SELECT r.amount, r.created_at
      FROM query_payment_reports r JOIN queries q ON q.id = r.query_id
     WHERE r.status = 'verified' AND r.target_kind = 'invoice' AND r.id <> p_report_id
       AND report_statement_id(r.claimed_statement_id, q.entity_type, q.entity_id) = v_sid
       AND (r.created_at, r.id) < (v_filed, p_report_id)
     ORDER BY r.created_at, r.id
  LOOP
    need := v.amount;
    FOR i IN 1..n LOOP
      EXIT WHEN need <= 0;
      CONTINUE WHEN pts[i] < v.created_at OR prem[i] <= 0;
      take := LEAST(need, prem[i]);
      prem[i] := prem[i] - take;
      need := need - take;
    END LOOP;
  END LOOP;

  FOR i IN 1..n LOOP
    IF pts[i] >= v_filed THEN total := total + prem[i]; END IF;
  END LOOP;
  RETURN total;
END;
$$;

-- Accounts just recorded p_payment_id: close the oldest open report on its
-- invoice that the money recorded since it was filed now covers. One payment
-- closes one report.
CREATE OR REPLACE FUNCTION close_covered_payment_report(p_payment_id UUID, p_actor UUID)
RETURNS TABLE(report_id UUID, query_id UUID, reported_by UUID, entity_type TEXT, entity_id UUID)
LANGUAGE plpgsql AS $$
DECLARE
  v_pay billing_payments%ROWTYPE;
  v_rid UUID;
  r     RECORD;
BEGIN
  SELECT * INTO v_pay FROM billing_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_pay.payment_mode IN ('deposit_adjustment', 'razorpay') OR v_pay.razorpay_payment_id IS NOT NULL THEN
    RETURN;
  END IF;

  -- Serialises with other payments and closes on the same invoice.
  PERFORM 1 FROM billing_statements WHERE id = v_pay.billing_statement_id FOR UPDATE;

  FOR r IN
    SELECT rp.id, rp.amount
      FROM query_payment_reports rp JOIN queries q ON q.id = rp.query_id
     WHERE rp.status = 'reported' AND rp.target_kind = 'invoice'
       AND report_statement_id(rp.claimed_statement_id, q.entity_type, q.entity_id) = v_pay.billing_statement_id
     ORDER BY rp.created_at, rp.id
  LOOP
    IF report_post_filing_credit(r.id) >= r.amount - 1 THEN
      v_rid := r.id;
      EXIT;
    END IF;
  END LOOP;
  IF v_rid IS NULL THEN RETURN; END IF;

  -- close_payment_report (00644) still insists the report names this invoice
  -- via claimed_statement_id; a statement-filed report may not carry it.
  UPDATE query_payment_reports SET claimed_statement_id = v_pay.billing_statement_id
   WHERE id = v_rid AND claimed_statement_id IS NULL;

  RETURN QUERY SELECT * FROM close_payment_report(v_rid, p_payment_id, p_actor);
END;
$$;

-- Reversal: reopen the report linked to the deleted payment, and any other
-- verified report on the invoice that was satisfied before and is not once the
-- payment is gone, oldest first so credit freed by one flows to the next.
CREATE OR REPLACE FUNCTION reopen_payment_reports_on_payment_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ids  UUID[];
  v_ok   BOOLEAN[];
  v_rep  RECORD;
  v_i    INT := 0;
  v_why  TEXT;
BEGIN
  -- Which verified reports on this invoice were satisfied before the delete.
  SELECT array_agg(r.id ORDER BY r.created_at, r.id),
         array_agg(report_post_filing_credit(r.id) >= r.amount - 1 ORDER BY r.created_at, r.id)
    INTO v_ids, v_ok
    FROM query_payment_reports r JOIN queries q ON q.id = r.query_id
   WHERE r.status = 'verified' AND r.target_kind = 'invoice'
     AND report_statement_id(r.claimed_statement_id, q.entity_type, q.entity_id) = OLD.billing_statement_id;

  FOR v_rep IN
    SELECT r.id, r.query_id, r.amount, r.billing_payment_id, r.reviewed_by, r.created_by
      FROM query_payment_reports r JOIN queries q ON q.id = r.query_id
     WHERE r.status = 'verified' AND r.target_kind = 'invoice'
       AND report_statement_id(r.claimed_statement_id, q.entity_type, q.entity_id) = OLD.billing_statement_id
     ORDER BY r.created_at, r.id
     FOR UPDATE OF r
  LOOP
    v_i := v_i + 1;
    v_why := NULL;
    IF v_rep.billing_payment_id = OLD.id THEN
      v_why := 'The payment this report was verified against was reversed, so the report is open again.';
    ELSIF COALESCE(v_ok[v_i], FALSE)
          AND report_post_filing_credit(v_rep.id, OLD.id) < v_rep.amount - 1 THEN
      v_why := 'A payment on the invoice was reversed, so the money recorded since this report was filed no longer covers it. It is open again.';
    END IF;

    IF v_why IS NOT NULL THEN
      UPDATE query_payment_reports
         SET status = 'reported', billing_payment_id = NULL,
             reviewed_by = NULL, reviewed_at = NULL, resolution_note = NULL
       WHERE id = v_rep.id;
      UPDATE queries
         SET status = 'open', resolved_by = NULL, resolved_at = NULL, escalated_at = NULL
       WHERE id = v_rep.query_id;
      INSERT INTO query_messages (query_id, event_type, body, created_by)
      VALUES (v_rep.query_id, 'reopened', v_why, COALESCE(v_rep.reviewed_by, v_rep.created_by));
    END IF;
  END LOOP;

  RETURN OLD;
END;
$$;

-- One-time clean-up, old basis on purpose: counts the credit on the invoice
-- regardless of when it was recorded, as in 00646. It is NOT the live rule above;
-- it exists to close reports filed after a payment was already recorded. Dry run
-- by default: it only lists. Never run it on production without reading the list.
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

-- Server-only, as in 00645.
REVOKE ALL ON FUNCTION report_post_filing_credit(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION close_covered_payment_report(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sweep_covered_payment_reports(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION report_post_filing_credit(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION close_covered_payment_report(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION sweep_covered_payment_reports(UUID, BOOLEAN) TO service_role;

NOTIFY pgrst, 'reload schema';
