-- Void columns for booking_gst_tasks, mirroring billing_statements'
-- existing void mechanism (00155_statement_void_columns.sql) so bad/test
-- booking rows can be excluded from the open Tally Inbox worklist the same
-- way voided statements already are, without deleting the underlying
-- booking/payment/GST-invoice data.

ALTER TABLE booking_gst_tasks
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by   UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_booking_gst_tasks_voided_at ON booking_gst_tasks(voided_at);
