-- A payment report closes when what accounts recorded matches what was
-- reported, never when it merely exceeds it.
--
-- 00646 closed a report once the unallocated credit was at least the reported
-- amount, so an over-payment closed it too. Accounts decided otherwise: more
-- than was reported means the report no longer describes what arrived, so it
-- stays open for accounts to look at. A report now closes when EITHER
--   (a) the payment just recorded equals the reported amount (cash, or cash
--       plus TDS, within one rupee), so payments recorded earlier without any
--       report cannot stop a later report from closing (15,000 recorded, then
--       5,000 reported and 5,000 recorded: closes); OR
--   (b) the unallocated credit on the invoice is within one rupee of the
--       reported amount, so part-payments that add up still close it
--       (6,000 then 4,000 for a 10,000 report).
-- A 12,000 payment against a 10,000 report matches neither and stays open; so
-- does 5,500 against 5,000 even with 15,000 already recorded. The sweep applies
-- the same two tests, so the live close and the clean-up cannot disagree.
--
-- Deposit adjustments are unchanged: they count as credit and never trigger a
-- close on their own.
--
-- Reopen-on-reversal (00646) needs no change. A report reopens when the payment
-- it is linked to is reversed, or when the remaining credit falls below the
-- reported amount. Reversing an earlier, unrelated payment that the report never
-- relied on (the 15,000) leaves it closed.
--
-- This file was amended before it reached any database but staging; 00646 is
-- untouched because it is already on production.
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
     AND (
           -- (a) the payment just recorded equals the report
           ABS(v_pay.amount - r.amount) <= 1
        OR ABS(v_pay.amount + COALESCE(v_pay.tds_amount, 0) - r.amount) <= 1
           -- (b) the credit on the invoice adds up to the report
        OR ABS(v_avail - r.amount) <= 1
         )
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
  CREATE TEMP TABLE IF NOT EXISTS _sweep_pay (pid UUID PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE _sweep_used;
  TRUNCATE _sweep_pay;

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

    -- (a) a bank payment on the invoice that equals this report, not yet linked.
    v_pay := NULL;
    SELECT bp.id INTO v_pay FROM billing_payments bp
     WHERE bp.billing_statement_id = r.sid
       AND bp.payment_mode NOT IN ('deposit_adjustment', 'razorpay') AND bp.razorpay_payment_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM query_payment_reports x WHERE x.billing_payment_id = bp.id AND x.status = 'verified')
       AND NOT EXISTS (SELECT 1 FROM _sweep_pay sp WHERE sp.pid = bp.id)
       AND (ABS(bp.amount - r.amount) <= 1 OR ABS(bp.amount + COALESCE(bp.tds_amount, 0) - r.amount) <= 1)
     ORDER BY bp.created_at DESC LIMIT 1;

    -- (b) otherwise the credit on the invoice must add up to the report.
    IF v_pay IS NULL THEN
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
         AND NOT EXISTS (SELECT 1 FROM _sweep_pay sp WHERE sp.pid = bp.id)
       ORDER BY bp.created_at DESC LIMIT 1;
    END IF;

    IF v_pay IS NULL THEN
      outcome := 'covered, but no unlinked bank payment to attach it to (use the card)';
      RETURN NEXT; CONTINUE;
    END IF;

    IF p_dry_run THEN
      outcome := 'would close';
      -- A dry run closes nothing, so remember what it would use; a real run
      -- sees its own closes through statement_unallocated_credit and the link.
      INSERT INTO _sweep_used (sid, used) VALUES (r.sid, r.amount)
        ON CONFLICT (sid) DO UPDATE SET used = _sweep_used.used + EXCLUDED.used;
      INSERT INTO _sweep_pay (pid) VALUES (v_pay) ON CONFLICT DO NOTHING;
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
