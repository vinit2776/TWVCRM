-- Repeatable test of the payment-report closing rule (migrations 00644-00647).
--
-- Rule under test: a report is satisfied by NEW money. For an open report on an
-- invoice, only payments recorded after the report was filed count (cash + TDS;
-- a deposit adjustment approved after filing counts as credit but never
-- triggers a close), minus what older reports on that invoice already used.
-- The report closes when that credit reaches the reported amount within one
-- rupee: an overpayment closes it, an underpayment does not. Payments recorded
-- before the report was filed do not close it by themselves.
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
  VALUES ((SELECT id FROM contracts ORDER BY created_at LIMIT 1), d, d, 100000, 'finalized')
  RETURNING id INTO v;
  RETURN v;
END $$;

-- Filed "now" (clock_timestamp, not the transaction's now(), so ordering against
-- payments is real), optionally backdated so one report is older than another.
CREATE FUNCTION pg_temp.mk_report(p_stmt UUID, p_amount NUMERIC, p_actor UUID, p_age INTERVAL DEFAULT '0') RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE q UUID; r UUID;
BEGIN
  PERFORM pg_sleep(0.003);
  INSERT INTO queries (created_by, entity_type, entity_id, kind)
  VALUES (p_actor, 'billing_statement', p_stmt, 'payment_reported') RETURNING id INTO q;
  INSERT INTO query_payment_reports (query_id, amount, paid_on, payment_mode, created_by, claimed_statement_id, created_at)
  VALUES (q, p_amount, CURRENT_DATE, 'neft', p_actor, p_stmt, clock_timestamp() - p_age) RETURNING id INTO r;
  RETURN r;
END $$;

-- Records a payment the way the route does (insert, then try to close).
CREATE FUNCTION pg_temp.pay(p_stmt UUID, p_amount NUMERIC, p_actor UUID, p_mode TEXT DEFAULT 'neft', p_tds NUMERIC DEFAULT 0, p_close BOOLEAN DEFAULT TRUE) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE p UUID;
BEGIN
  PERFORM pg_sleep(0.003);
  INSERT INTO billing_payments (billing_statement_id, amount, tds_amount, payment_date, payment_mode, recorded_by, created_at)
  VALUES (p_stmt, p_amount, p_tds, CURRENT_DATE, p_mode, p_actor, clock_timestamp()) RETURNING id INTO p;
  IF p_close THEN PERFORM * FROM close_covered_payment_report(p, p_actor); END IF;
  RETURN p;
END $$;

CREATE FUNCTION pg_temp.st(p_report UUID) RETURNS TEXT LANGUAGE sql AS $$
  SELECT r.status || '/' || q.status FROM query_payment_reports r JOIN queries q ON q.id = r.query_id WHERE r.id = p_report
$$;

CREATE FUNCTION pg_temp.pid(p_report UUID) RETURNS UUID LANGUAGE sql AS $$
  SELECT billing_payment_id FROM query_payment_reports WHERE id = p_report
$$;

DO $$
DECLARE
  a UUID := (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1);
  s UUID; r UUID; r2 UUID; p0 UUID; p1 UUID; p2 UUID;
  res TEXT := '';
BEGIN
  IF a IS NULL THEN RAISE EXCEPTION 'no admin user to act as'; END IF;

  -- A. Payments recorded EARLIER with no report do not close a later report.
  -- Invoice with 15,000 already recorded; Sales files a 3,000 report.
  s := pg_temp.mk_stmt();
  p0 := pg_temp.pay(s, 15000, a);
  res := res || E'\n' || CASE WHEN (SELECT count(*) FROM close_covered_payment_report(p0, a)) = 0 THEN 'PASS' ELSE 'FAIL' END || ' A1 the unreported 15,000 itself closes nothing';
  r := pg_temp.mk_report(s, 3000, a);
  PERFORM pg_temp.pay(s, 100, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' A2 earlier 15,000 + 3,000 report + 100 payment stays open: ' || pg_temp.st(r);
  PERFORM pg_temp.pay(s, 2900, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' A3 ...then 2,900 more (3,000 since filing) closes: ' || pg_temp.st(r);

  s := pg_temp.mk_stmt();
  PERFORM pg_temp.pay(s, 15000, a); r := pg_temp.mk_report(s, 3000, a);
  PERFORM pg_temp.pay(s, 3000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' A4 earlier 15,000 + 3,000 report + 3,000 payment closes: ' || pg_temp.st(r);

  s := pg_temp.mk_stmt();
  PERFORM pg_temp.pay(s, 15000, a); r := pg_temp.mk_report(s, 3000, a);
  PERFORM pg_temp.pay(s, 2000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' A5 2,000 of 3,000 stays open: ' || pg_temp.st(r);
  PERFORM pg_temp.pay(s, 1000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' A6 2,000 then 1,000 closes: ' || pg_temp.st(r);

  -- Payments before the report was filed cannot close it by themselves, however big.
  s := pg_temp.mk_stmt();
  p0 := pg_temp.pay(s, 10000, a);
  r := pg_temp.mk_report(s, 10000, a);
  res := res || E'\n' || CASE WHEN (SELECT count(*) FROM close_covered_payment_report(p0, a)) = 0 AND pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' A7 a 10,000 recorded before the 10,000 report was filed does not close it: ' || pg_temp.st(r);
  PERFORM pg_temp.pay(s, 100, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' A8 ...and a later 100 does not either: ' || pg_temp.st(r);

  -- B. The amount rule: overpayment closes, underpayment does not.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 10000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' B1 exact payment closes: ' || pg_temp.st(r);
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 12000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' B2 12,000 against 10,000 (overpayment) closes: ' || pg_temp.st(r);
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 6000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' B3 6,000 alone stays open: ' || pg_temp.st(r);
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 9999, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' B4 one rupee short closes: ' || pg_temp.st(r);
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 9998, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' B5 two rupees short stays open: ' || pg_temp.st(r);
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 12980, a);
  PERFORM pg_temp.pay(s, 11880, a, 'neft', 1100);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' B6 net plus TDS closes: ' || pg_temp.st(r);

  -- C. Several reports on one invoice: older claim first, money never reused.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 6000, a, '2 days'); r2 := pg_temp.mk_report(s, 4000, a, '1 day');
  p1 := pg_temp.pay(s, 6000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' AND pg_temp.st(r2) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' C1 6,000 closes the older 6,000 report, not the 4,000: ' || pg_temp.st(r) || ' / ' || pg_temp.st(r2);
  p2 := pg_temp.pay(s, 4000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r2) = 'verified/resolved' AND pg_temp.pid(r) = p1 AND pg_temp.pid(r2) = p2 THEN 'PASS' ELSE 'FAIL' END || ' C2 then 4,000 closes the 4,000 report; the 6,000 was not reused: ' || pg_temp.st(r2);

  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a, '2 days'); r2 := pg_temp.mk_report(s, 10000, a, '1 day');
  PERFORM pg_temp.pay(s, 10000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' AND pg_temp.st(r2) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' C3 two equal reports, one payment: only the oldest closes: ' || pg_temp.st(r) || ' / ' || pg_temp.st(r2);

  -- D. Deposit adjustments: credit after filing, never a trigger.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  p1 := pg_temp.pay(s, 10000, a, 'deposit_adjustment');
  res := res || E'\n' || CASE WHEN (SELECT count(*) FROM close_covered_payment_report(p1, a)) = 0 AND pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' D1 a deposit adjustment alone does not trigger a close: ' || pg_temp.st(r);
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 4000, a, 'deposit_adjustment');
  PERFORM pg_temp.pay(s, 6000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' D2 adjustment after filing + bank payment satisfies it: ' || pg_temp.st(r);
  s := pg_temp.mk_stmt();
  PERFORM pg_temp.pay(s, 4000, a, 'deposit_adjustment');
  r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 6000, a);
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' D3 an adjustment recorded BEFORE filing does not count: ' || pg_temp.st(r);

  -- E. Reversal.
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  p1 := pg_temp.pay(s, 10000, a);
  DELETE FROM billing_payments WHERE id = p1;
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' E1 reversing the linked payment reopens: ' || pg_temp.st(r);

  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 3000, a);
  p1 := pg_temp.pay(s, 2000, a); p2 := pg_temp.pay(s, 1000, a);
  DELETE FROM billing_payments WHERE id = p1;
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'reported/open' THEN 'PASS' ELSE 'FAIL' END || ' E2 reversing the earlier of 2,000 + 1,000 reopens: ' || pg_temp.st(r);

  s := pg_temp.mk_stmt();
  p0 := pg_temp.pay(s, 15000, a); r := pg_temp.mk_report(s, 3000, a);
  PERFORM pg_temp.pay(s, 3000, a);
  DELETE FROM billing_payments WHERE id = p0;
  res := res || E'\n' || CASE WHEN pg_temp.st(r) = 'verified/resolved' THEN 'PASS' ELSE 'FAIL' END || ' E3 reversing the earlier unreported 15,000 leaves it closed: ' || pg_temp.st(r);

  -- F. The one-time sweep keeps the old basis: credit regardless of date.
  s := pg_temp.mk_stmt();
  PERFORM pg_temp.pay(s, 5000, a, 'neft', 0, FALSE);
  r := pg_temp.mk_report(s, 5000, a);   -- the payment came BEFORE the report
  res := res || E'\n' || CASE WHEN (SELECT outcome FROM sweep_covered_payment_reports(a, TRUE) WHERE report_id = r) = 'would close' THEN 'PASS' ELSE 'FAIL' END || ' F1 sweep (old basis): a payment recorded before filing would close it';
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 12000, a, 'neft', 0, FALSE);
  res := res || E'\n' || CASE WHEN (SELECT outcome FROM sweep_covered_payment_reports(a, TRUE) WHERE report_id = r) = 'would close' THEN 'PASS' ELSE 'FAIL' END || ' F2 sweep: overpayment would close';
  s := pg_temp.mk_stmt(); r := pg_temp.mk_report(s, 10000, a);
  PERFORM pg_temp.pay(s, 6000, a, 'neft', 0, FALSE);
  res := res || E'\n' || CASE WHEN (SELECT outcome FROM sweep_covered_payment_reports(a, TRUE) WHERE report_id = r) LIKE 'stays open (recorded credit is less%' THEN 'PASS' ELSE 'FAIL' END || ' F3 sweep: partial stays open';

  -- Raising here rolls the whole transaction back: no test data survives.
  RAISE EXCEPTION 'PAYMENT_REPORT_COVERAGE_RESULTS%', res;
END $$;
