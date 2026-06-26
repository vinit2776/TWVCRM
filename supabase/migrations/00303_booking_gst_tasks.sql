-- 00303_booking_gst_tasks.sql
--
-- Extends the Tally Inbox to cover non-contract (walk-in / guest) bookings.
-- When a booking is checked out AND fully paid, accounts must create a GST
-- invoice in Tally for it. This table tracks that workflow per booking.
--
-- Also relaxes the NOT NULL on gst_invoice_uploads.billing_statement_id so
-- uploads can reference a booking_gst_task instead of a billing_statement.

-- ── 1. booking_gst_tasks ────────────────────────────────────────────────────

CREATE TABLE booking_gst_tasks (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            uuid         NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  handoff_state         text         NOT NULL DEFAULT 'gst_to_issue',
  gst_invoice_number    text,
  tally_invoice_number  text,
  tally_total_amount    numeric(12,2),
  issuance_channel      text,
  gst_invoice_sent_at   timestamptz,
  gst_invoice_sent_to   text,
  tally_delivered_at    timestamptz,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT booking_gst_tasks_booking_id_key UNIQUE (booking_id),
  CONSTRAINT booking_gst_tasks_handoff_state_check CHECK (
    handoff_state IN ('gst_to_issue', 'ready_to_send', 'complete')
  )
);

ALTER TABLE booking_gst_tasks ENABLE ROW LEVEL SECURITY;

-- Inbox roles can read tasks
CREATE POLICY "booking_gst_tasks_select" ON booking_gst_tasks
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid()
      AND u.role IN ('accounts', 'admin', 'office_admin', 'manager')
    )
  );

-- Any authenticated user can create a task (checkout is not role-gated).
-- The application layer (checkout + payment verification code) controls when
-- this actually fires; the service role bypasses RLS anyway in server routes.
CREATE POLICY "booking_gst_tasks_insert" ON booking_gst_tasks
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- Only accounts/admin can update task state
CREATE POLICY "booking_gst_tasks_update" ON booking_gst_tasks
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid()
      AND u.role IN ('accounts', 'admin')
    )
  );

-- Partial index: only non-complete tasks (mirrors billing_statements approach)
CREATE INDEX idx_booking_gst_tasks_open
  ON booking_gst_tasks (handoff_state)
  WHERE handoff_state != 'complete';

CREATE INDEX idx_booking_gst_tasks_booking_id
  ON booking_gst_tasks (booking_id);

-- ── 2. gst_invoice_uploads — relax billing_statement_id, add booking FK ────

-- Make billing_statement_id nullable so uploads can belong to a booking task
ALTER TABLE gst_invoice_uploads
  ALTER COLUMN billing_statement_id DROP NOT NULL;

-- Add the new FK column
ALTER TABLE gst_invoice_uploads
  ADD COLUMN booking_gst_task_id uuid REFERENCES booking_gst_tasks(id) ON DELETE RESTRICT;

-- Exactly one source must be set
ALTER TABLE gst_invoice_uploads
  ADD CONSTRAINT gst_invoice_uploads_source_xor CHECK (
    (billing_statement_id IS NOT NULL AND booking_gst_task_id IS NULL) OR
    (billing_statement_id IS NULL AND booking_gst_task_id IS NOT NULL)
  );

-- Index for quick lookup by task
CREATE INDEX idx_gst_uploads_booking_task
  ON gst_invoice_uploads (booking_gst_task_id)
  WHERE booking_gst_task_id IS NOT NULL;
