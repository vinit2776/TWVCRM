-- A reporter can take back a payment report until accounts has verified it.
--
-- Until now a report could only end as verified or rejected, both accounts-only,
-- so a wrong amount or date on an unverified report stayed stuck until accounts
-- rejected it. 'withdrawn' is a fourth terminal state: the report no longer
-- counts as claimed money, so the amount is reportable again. The existing
-- query_payment_reports_reviewed_together CHECK still holds (the person who
-- withdraws is stamped as reviewed_by/reviewed_at, like any other close).
--
-- Rollback (only safe while no row is 'withdrawn'; otherwise first
-- UPDATE query_payment_reports SET status = 'rejected', resolution_note = 'Withdrawn' WHERE status = 'withdrawn'):
--   ALTER TABLE query_payment_reports DROP CONSTRAINT query_payment_reports_status_check;
--   ALTER TABLE query_payment_reports ADD CONSTRAINT query_payment_reports_status_check
--     CHECK (status IN ('reported', 'verified', 'rejected'));

ALTER TABLE query_payment_reports DROP CONSTRAINT IF EXISTS query_payment_reports_status_check;
ALTER TABLE query_payment_reports ADD CONSTRAINT query_payment_reports_status_check
  CHECK (status IN ('reported', 'verified', 'rejected', 'withdrawn'));
