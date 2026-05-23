-- Leave policy, per-employee balances, and individual leave requests.

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE leave_type   AS ENUM ('cl', 'sl', 'lop');
CREATE TYPE leave_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- ── Company-wide leave policy (one row per calendar year) ────────────────────

CREATE TABLE employee_leave_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_year         integer NOT NULL UNIQUE,
  cl_days_per_year    integer NOT NULL DEFAULT 12,
  sl_days_per_year    integer NOT NULL DEFAULT 12,
  lop_tracked         boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE employee_leave_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read leave policies"
  ON employee_leave_policies FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage leave policies"
  ON employee_leave_policies FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Per-employee per-year leave balance ──────────────────────────────────────

CREATE TABLE employee_leave_balances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  policy_year     integer NOT NULL,
  cl_total        integer NOT NULL,
  cl_used         integer NOT NULL DEFAULT 0,
  sl_total        integer NOT NULL,
  sl_used         integer NOT NULL DEFAULT 0,
  lop_days        integer NOT NULL DEFAULT 0,  -- cumulative LOP taken this year
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(employee_id, policy_year)
);

-- Derived balances are computed in application code to avoid generated column complexity.
-- cl_balance = cl_total - cl_used, sl_balance = sl_total - sl_used

ALTER TABLE employee_leave_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read leave balances"
  ON employee_leave_balances FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage leave balances"
  ON employee_leave_balances FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Individual leave requests ─────────────────────────────────────────────────

CREATE TABLE employee_leave_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type      leave_type NOT NULL,
  from_date       date NOT NULL,
  to_date         date NOT NULL,
  days_count      integer NOT NULL,   -- weekday-only count, computed on submission
  reason          text,
  status          leave_status NOT NULL DEFAULT 'pending',
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  review_note     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE employee_leave_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read leave requests"
  ON employee_leave_requests FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert leave requests"
  ON employee_leave_requests FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update leave requests"
  ON employee_leave_requests FOR UPDATE TO authenticated USING (true);

-- Index for payroll run query: get all approved leaves for a month
CREATE INDEX idx_leave_requests_employee_status_dates
  ON employee_leave_requests(employee_id, status, from_date, to_date);
