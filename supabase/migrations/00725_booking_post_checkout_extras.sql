-- 00725_booking_post_checkout_extras.sql
--
-- Extras found after checkout (overtime, damage, missed F&B) on a walk-in/guest booking
-- become add-ons on that booking, so the payment dialog, link, PI, Receivables and Tally
-- all see them. Two things follow:
--   * an add-on is tagged when it was added after checkout and, once a Tally task has
--     claimed it on an invoice, points at that task;
--   * a booking can have more than one Tally task: the main one, and a supplement for an
--     extra that arrives after accounts already issued the GST invoice.
-- Existing tables only, so no new RLS. Rollback: drop the added columns and the new
-- unique index, and restore UNIQUE (booking_id) once no booking has two tasks.

ALTER TABLE booking_addons
  ADD COLUMN IF NOT EXISTS added_after_checkout boolean NOT NULL DEFAULT false;

ALTER TABLE booking_gst_tasks
  ADD COLUMN IF NOT EXISTS kind            text          NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS sequence        integer       NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS amount_with_gst numeric(12,2);

ALTER TABLE booking_gst_tasks
  DROP CONSTRAINT IF EXISTS booking_gst_tasks_kind_check;
ALTER TABLE booking_gst_tasks
  ADD CONSTRAINT booking_gst_tasks_kind_check CHECK (kind IN ('main', 'supplement'));

ALTER TABLE booking_addons
  ADD COLUMN IF NOT EXISTS gst_task_id uuid REFERENCES booking_gst_tasks(id) ON DELETE SET NULL;

-- One task per (booking, sequence) replaces one task per booking.
ALTER TABLE booking_gst_tasks
  DROP CONSTRAINT IF EXISTS booking_gst_tasks_booking_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS booking_gst_tasks_booking_sequence_key
  ON booking_gst_tasks (booking_id, sequence);

-- Existing tasks were created for the booking's total at the time.
UPDATE booking_gst_tasks t
   SET amount_with_gst = b.total_amount_with_gst
  FROM bookings b
 WHERE b.id = t.booking_id
   AND t.amount_with_gst IS NULL;
