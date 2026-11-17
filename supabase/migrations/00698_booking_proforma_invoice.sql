-- 00698_booking_proforma_invoice.sql
--
-- Optional proforma invoice (PI) for a booking, sent with the payment link so a
-- customer can pay in advance. A PI is not a tax invoice: it carries no GST
-- invoice number and does not touch payment_status. Rollback: drop the four
-- columns.
--
-- bookings already has RLS enabled; these columns inherit its policies.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS pi_number   text,
  ADD COLUMN IF NOT EXISTS pi_sent_at  timestamptz,
  ADD COLUMN IF NOT EXISTS pi_sent_by  uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS pi_sent_to  text;
