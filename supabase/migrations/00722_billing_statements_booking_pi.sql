-- 00722_billing_statements_booking_pi.sql
--
-- A proforma invoice (PI) issued for a booking now lives in Receivables as a
-- billing statement owned by the booking (booking_id already exists, 00041).
-- This only widens the created_via CHECK with the new origin value; it adds no
-- table, so no new RLS. Rollback: re-add the constraint without 'booking_pi'
-- after deleting or relabelling any rows that use it.

ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_created_via_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_created_via_check
  CHECK (created_via IS NULL OR created_via IN (
    'cron',
    'ad_hoc_request',
    'manual_correction',
    'legacy',
    'proposal_pi',
    'adhoc_invoice',
    'vo_case_request',
    'vo_aggregator_monthly',
    'booking_pi'             -- PI sent for a walk-in/guest booking (Send PI + link)
  ));
