-- Attendance corrections: HR-submitted corrections for missing or wrong punches.
-- Missing checkouts flagged by the daily cron also land here with status 'pending'.

CREATE TYPE attendance_correction_type AS ENUM (
  'add_in',            -- add a missing check-in punch
  'add_out',           -- add a missing check-out punch
  'override_time',     -- correct a wrong punch time
  'missing_checkout'   -- auto-flagged by cron (no manual OUT detected by shift end)
);

CREATE TYPE attendance_correction_status AS ENUM (
  'pending',
  'approved',
  'applied',
  'rejected'
);

CREATE TABLE attendance_corrections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  correction_date   date NOT NULL,
  correction_type   attendance_correction_type NOT NULL,
  original_time     timestamptz,                  -- null for add_in / add_out
  corrected_time    timestamptz NOT NULL,
  reason            text,
  status            attendance_correction_status NOT NULL DEFAULT 'pending',
  submitted_by      uuid REFERENCES users(id),
  reviewed_by       uuid REFERENCES users(id),
  reviewed_at       timestamptz,
  review_note       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE attendance_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read attendance corrections"
  ON attendance_corrections FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert attendance corrections"
  ON attendance_corrections FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Admin/manager/office_admin can update attendance corrections"
  ON attendance_corrections FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role IN ('admin', 'manager', 'office_admin', 'floor_manager')
    )
  );

CREATE INDEX idx_attendance_corrections_employee_date
  ON attendance_corrections(employee_id, correction_date);

CREATE INDEX idx_attendance_corrections_status
  ON attendance_corrections(status) WHERE status = 'pending';
