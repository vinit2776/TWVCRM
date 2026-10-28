-- A payment report closes when the credit recorded on its invoice equals the
-- reported amount, not when it merely reaches it.
--
-- 00646 closed a report once the unallocated credit was at least the reported
-- amount, so an over-payment closed it too. Accounts decided otherwise: parts
-- that add up to the reported amount close it, but more than was reported means
-- the report no longer describes what arrived, so it stays open for accounts to
-- look at. The test is now "unallocated credit within one rupee of the reported
-- amount", in the live close and in the one-off sweep, so both still agree.
--
-- Deposit adjustments are unchanged: they count as credit and never trigger a
-- close on their own.
--
-- Reopen-on-reversal (00646) needs no change. A report is reopened when the
-- credit falls below the reported amount, which is the same condition as
-- before; extra credit recorded after a close never reopens anything.
--
-- Rollback: re-run the two function definitions from 00646
--   (close_covered_payment_report and sweep_covered_payment_reports).

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
     AND ABS(v_avail - r.amount) <= 1
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

    IF v_avail < r.amount - 1 THEN
      outcome := 'stays open (recorded credit is less than reported)';
      RETURN NEXT; CONTINUE;
    ELSIF v_avail > r.amount + 1 THEN
      outcome := 'stays open (recorded credit is more than reported)';
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

-- CREATE OR REPLACE keeps the existing grants, but state them so this file is
-- safe to read on its own.
REVOKE ALL ON FUNCTION close_covered_payment_report(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sweep_covered_payment_reports(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION close_covered_payment_report(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION sweep_covered_payment_reports(UUID, BOOLEAN) TO service_role;

NOTIFY pgrst, 'reload schema';
