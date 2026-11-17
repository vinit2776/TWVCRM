-- 00723_billing_payments_booking_mirror_unique.sql
--
-- A booking PI's billing statement mirrors the booking's verified payments as
-- billing_payments rows marked 'booking_payment:<id>'. Two syncs running at once
-- (link webhook + a counter verification, or a webhook retry) must not both
-- insert the same mirror, or the payment is credited twice. This partial unique
-- index makes the second insert fail. No table is added, so no new RLS.
-- Rollback: DROP INDEX billing_payments_booking_mirror_uniq.

CREATE UNIQUE INDEX IF NOT EXISTS billing_payments_booking_mirror_uniq
  ON billing_payments (billing_statement_id, payment_reference)
  WHERE payment_reference LIKE 'booking_payment:%';
