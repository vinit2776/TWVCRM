-- Repeatable test of the payment-report coverage rule (migrations 00644-00647).
--
-- Run against STAGING only:
--   npx supabase db query --linked -f supabase/tests/payment_report_coverage.sql
-- (check supabase/.temp/project-ref is the staging ref first.)
--
-- It builds throw-away invoices, reports and payments, exercises
-- close_covered_payment_report, sweep_covered_payment_reports and the reversal
-- trigger, then ends by raising an exception that carries the result table.
-- That exception rolls everything back, so nothing is left in the database.
-- Read the output: every line should say PASS, and the message starts with
-- PAYMENT_REPORT_COVERAGE_RESULTS.

BEGIN;

CREATE TEMP SEQUENCE _fixture_seq;

-- A statement needs a source (billing_statements_source_check) and a distinct
-- period per contract, so borrow any contract and give each fixture its own day.
CREATE FUNCTION pg_temp.mk_stmt() RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v UUID; d DATE := DATE '1990-01-01' + nextval('_fixture_seq')::INT;
BEGIN
  INSERT INTO billing_statements (contract_id, period_start, period_end, total_amount, status)
  VALUES ((SELECT id FROM contracts ORDER BY created_at LIMIT 1), d, d, 10000, 'finalized')
  RETURNING id INTO v;
  RETURN v;
END $$;

CREATE FUNCTION pg_temp.mk_report(p_stmt UUID, p_amount NUMERIC, p_actor UUID, p_age INTERVAL DEFAULT '0') RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE q UUID; r UUID;
BEGIN
  INSERT INTO queries (created_by, entity_type, entity_id, kind)
  VALUES (p_actor, 'billing_statement', p_stmt, 'payment_reported') RETURNING id INTO q;
  INSERT INTO query_payment_reports (query_id, amount, paid_on, payment_mode, created_by, claimed_statement_id, created_at)
  VALUES (q, p_amount, CURRENT_DATE, 'neft', p_actor, p_stmt, now() - p_age) RETURNING id INTO r;
  RETURN r;
END $$;

-- Records a payment the way the route does (insert, then try to close).
CREATE FUNCTION pg_temp.pay(p_stmt UUID, p_amount NUMERIC, p_actor UUID, p_mode TEXT DEFAULT 'neft', p_tds NUMERIC DEFAULT 0, p_close BOOLEAN DEFAULT TRUE) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE p UUID;
BEGIN
  INSERT INTO billing_payments (billing_statement_id, amount, tds_amount, payment_date, payment_mode, recorded_by)
  VALUES (p_stmt, p_amount, p_tds, CURRENT_DATE, p_mode, p_actor) RETURNING id INTO p;
  IF p_close THEN PERFORM * FROM close_covered_payment_report(p, p_actor); END IF;
  RETURN p;
END $$;

CREATE FUNCTION pg_temp.st(p_report UUID) RETURNS TEXT LANGUAGE sql AS $$
  SELECT r.status || '/' || q.status FROM query_payment_reports r JOIN queries q ON q.id = r.query_id WHERE r.id = p_report
$$;

DO $$
DECLARE
  a UUID := (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1);
  s UUID; r UUID; r2 UUID; p1 UUID; p2 UUID;
  res TEXT := '';
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no admin user to act as'; END IF;

  -- 1. One payment equal to the report closes it.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 10000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' exact payment closes: ' || pg_temp.st(r);

  -- 2. 6,000 then 4,000: open after the first, closed after the second.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  p1 := pg_temp.pay(s, 6000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' 6,000 alone stays open: ' || pg_temp.st(r);
  p2 := pg_temp.pay(s, 4000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' 6,000 then 4,000 closes: ' || pg_temp.st(r);

  -- 3. Reversing the EARLIER part-payment (not the linked one) reopens it.
  DELETE FROM billing_payments WHERE id = p1;
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' reversing a part-payment reopens: ' || pg_temp.st(r);

  -- 4. Overpayment does not close it.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 12000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' 12,000 overpayment stays open: ' || pg_temp.st(r);

  -- 5. Two reports, one payment: only the older closes.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a, '2 days'); r2 := pg_temp.mk_report(s, 10000, a, '1 day');
  PERFORM pg_temp.pay(s, 10000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' AND pg_temp.st(r2) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' oldest of two closes: older=' || pg_temp.st(r) || ' newer=' || pg_temp.st(r2);

  -- 6. A deposit adjustment alone does not trigger a close...
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 10000, a, 'deposit_adjustment');
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' deposit adjustment alone does not close: ' || pg_temp.st(r);

  -- 7. ...but it counts as credit: 4,000 adjustment + 6,000 bank closes.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 4000, a, 'deposit_adjustment');
  PERFORM pg_temp.pay(s, 6000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' adjustment counts as credit: ' || pg_temp.st(r);

  -- 8. Reversing the linked payment reopens.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  p1 := pg_temp.pay(s, 10000, a);
  DELETE FROM billing_payments WHERE id = p1;
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' reversing the linked payment reopens: ' || pg_temp.st(r);

  -- 9. One rupee of rounding is fine, two is not.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 10001, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' +1 rupee closes: ' || pg_temp.st(r);
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 10002, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' +2 rupees stays open: ' || pg_temp.st(r);

  -- 10. Net plus TDS counts (12,980 reported; 11,880 + 1,100 TDS recorded).
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 12980, a);
  PERFORM pg_temp.pay(s, 11880, a, 'neft', 1100);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' net plus TDS closes: ' || pg_temp.st(r);

  -- 11. A partial payment alone stays open.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 6000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' 6,000 only stays open: ' || pg_temp.st(r);

  -- 12. The sweep agrees with the live rule (dry run, fixtures only).
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);   -- exact, recorded without trying to close
  PERFORM pg_temp.pay(s, 10000, a, 'neft', 0, FALSE);
  res := res || E'\n' || CASE WHEN (SELECT outcome FROM sweep_covered_payment_reports(a, TRUE) WHERE report_id = r) = 'would close' THEN 'PASS' ELSE 'FAIL' END || ' sweep: exact would close';
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 12000, a, 'neft', 0, FALSE);
  res := res || E'\n' || CASE WHEN (SELECT outcome FROM sweep_covered_payment_reports(a, TRUE) WHERE report_id = r) LIKE 'stays open (recorded credit is more%' THEN 'PASS' ELSE 'FAIL' END || ' sweep: overpayment stays open';
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 6000, a, 'neft', 0, FALSE);
  res := res || E'\n' || CASE WHEN (SELECT outcome FROM sweep_covered_payment_reports(a, TRUE) WHERE report_id = r) LIKE 'stays open (recorded credit is less%' THEN 'PASS' ELSE 'FAIL' END || ' sweep: partial stays open';

  -- 13. Payments recorded earlier with no report must not stop a later report
  -- from closing: 15,000 recorded, then 5,000 reported and 5,000 recorded.
  s := pg_temp.mk_stmt();
  p1 := pg_temp.pay(s, 15000, a, 'neft', 0, FALSE);
  res := res || E'\n' || CASE WHEN (SELECT count(*) FROM close_covered_payment_report(p1, a)) = 0 THEN 'PASS' ELSE 'FAIL' END || ' the unreported 15,000 itself closes nothing';
  r := pg_temp.mk_report(s, 5000, a);
  p2 := pg_temp.pay(s, 5000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' earlier 15,000 + report 5,000 + payment 5,000 closes: ' || pg_temp.st(r);

  -- 14. ...but a 5,500 payment against that 5,000 report stays open.
  s := pg_temp.mk_stmt();
  PERFORM pg_temp.pay(s, 15000, a, 'neft', 0, FALSE);
  r := pg_temp.mk_report(s, 5000, a);
  PERFORM pg_temp.pay(s, 5500, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' earlier 15,000 + 5,500 payment stays open: ' || pg_temp.st(r);

  -- 15. Reversing the 5,000 payment reopens the report; reversing the earlier
  -- 15,000 (which the report never relied on) does not.
  s := pg_temp.mk_stmt();
  p1 := pg_temp.pay(s, 15000, a, 'neft', 0, FALSE);
  r := pg_temp.mk_report(s, 5000, a);
  p2 := pg_temp.pay(s, 5000, a);
  DELETE FROM billing_payments WHERE id = p1;
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' reversing the earlier 15,000 leaves it closed: ' || pg_temp.st(r);
  DELETE FROM billing_payments WHERE id = p2;
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' reversing the 5,000 payment reopens: ' || pg_temp.st(r);

  -- 16. The sweep agrees: an exact payment among earlier ones would close; a
  -- 5,500 one would not.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 5000, a);
  PERFORM pg_temp.pay(s, 15000, a, 'neft', 0, FALSE);
  PERFORM pg_temp.pay(s, 5000, a, 'neft', 0, FALSE);
  res := res || E'\n' || CASE WHEN (SELECT outcome FROM sweep_covered_payment_reports(a, TRUE) WHERE report_id = r) = 'would close' THEN 'PASS' ELSE 'FAIL' END || ' sweep: earlier 15,000 + exact 5,000 would close';
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 5000, a);
  PERFORM pg_temp.pay(s, 15000, a, 'neft', 0, FALSE);
  PERFORM pg_temp.pay(s, 5500, a, 'neft', 0, FALSE);
  res := res || E'\n' || CASE WHEN (SELECT outcome FROM sweep_covered_payment_reports(a, TRUE) WHERE report_id = r) LIKE 'stays open%' THEN 'PASS' ELSE 'FAIL' END || ' sweep: earlier 15,000 + 5,500 stays open';

  -- Raising here rolls the whole transaction back: no test data survives.
  RAISE EXCEPTION 'PAYMENT_REPORT_COVERAGE_RESULTS%', res;
END $$;
