-- 00724_receivable_reminder_sends_booking_pi.sql
--
-- Follow-ups for a booking's PI are logged in receivable_reminder_sends like the
-- other non-statement receivables, so the kind CHECK has to accept 'booking_pi'.
-- Widens a CHECK only: no new table, so no new RLS.
-- Rollback: re-add the constraint without 'booking_pi' after deleting those rows.

ALTER TABLE receivable_reminder_sends
  DROP CONSTRAINT IF EXISTS receivable_reminder_sends_kind_check;

ALTER TABLE receivable_reminder_sends
  ADD CONSTRAINT receivable_reminder_sends_kind_check
  CHECK (kind IN ('deposit', 'topup', 'adhoc_invoice', 'booking_pi'));
