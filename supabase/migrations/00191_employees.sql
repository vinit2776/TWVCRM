-- Employees — staff who are not CRM app users but need device access + attendance
CREATE TABLE employees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid REFERENCES locations(id) ON DELETE SET NULL,
  full_name       text NOT NULL,
  phone           text,
  email           text,
  department      text,
  designation     text,
  -- Unique numeric ref used in COSEC event logs (auto-assigned, 1-99999999)
  cosec_ref_id    integer UNIQUE,
  is_active       boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read employees"
  ON employees FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin/manager/office_admin can manage employees"
  ON employees FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role IN ('admin', 'manager', 'office_admin', 'floor_manager')
    )
  );

-- Sequence for auto-assigning cosec_ref_id to employees
-- Contracts use their own numeric ID range; employees start at 50001
-- Bookings use a separate range starting at 90001
-- This keeps them non-overlapping in the 8-digit space
CREATE SEQUENCE employee_cosec_ref_seq START 50001 INCREMENT 1 MAXVALUE 89999;
