-- Populate cases.end_date, which has never been set on any case.
--
-- calculateEndDate had no callers, and the only code that writes end_date
-- lives inside the renewal-payment handler — which cannot run until the
-- renewal cron picks a case up, which requires end_date. A closed loop that
-- could never start, so all 58 production cases carried NULL.
--
-- Consequences of the NULL, all of which this unblocks:
--   * every stage of /api/cron/vo-renewal compares end_date, and SQL
--     comparisons are never true against NULL — nothing could ever renew,
--     enter grace, or lapse
--   * no expiry could be shown, filtered, or highlighted anywhere in the UI
--
-- end_date is the last day of the term: start_date + tenure_months, minus one
-- day. Matches calculateEndDate() in src/lib/case-workflow.ts, which the
-- application now uses on create and on any edit touching either input.
--
-- Only fills genuinely empty values. Renewal advances end_date beyond the
-- original term, so an existing value is always the more current one.
--
-- Rollback:
--   UPDATE cases SET end_date = NULL WHERE id IN (SELECT id FROM cases_end_date_backup_00525);
--   (capture first: CREATE TABLE cases_end_date_backup_00525 AS
--      SELECT id, end_date FROM cases WHERE end_date IS NULL;)

UPDATE cases
SET end_date = (start_date + (tenure_months || ' months')::interval - INTERVAL '1 day')::date
WHERE end_date IS NULL
  AND start_date IS NOT NULL
  AND tenure_months IS NOT NULL
  AND tenure_months > 0;
