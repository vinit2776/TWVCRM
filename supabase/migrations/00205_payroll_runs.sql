-- Monthly payroll runs and per-employee payslips.
-- Lifecycle mirrors billing_statements: draft → finalized.
-- All numbers on payslips are snapshotted at generation time so the slip
-- remains accurate even if the salary definition is later updated.

-- ── Enum ─────────────────────────────────────────────────────────────────────

CREATE TYPE payroll_run_status AS ENUM ('draft', 'finalized');

-- ── One run per calendar month ────────────────────────────────────────────────

CREATE TABLE payroll_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_month         date NOT NULL UNIQUE,  -- always the 1st of the month
  status            payroll_run_status NOT NULL DEFAULT 'draft',
  total_gross       numeric(12,2) NOT NULL DEFAULT 0,
  total_deductions  numeric(12,2) NOT NULL DEFAULT 0,
  total_net         numeric(12,2) NOT NULL DEFAULT 0,
  employee_count    integer NOT NULL DEFAULT 0,
  finalized_by      uuid REFERENCES users(id),
  finalized_at      timestamptz,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read payroll runs"
  ON payroll_runs FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage payroll runs"
  ON payroll_runs FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Per-employee payslip (one per employee per run) ───────────────────────────

CREATE TABLE payroll_slips (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id        uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES employees(id),

  -- Snapshot of employee info at time of run
  employee_name         text NOT NULL,
  department            text,
  designation           text,

  -- Attendance (sourced from COSEC access_logs at generation time)
  working_days          integer NOT NULL,    -- calendar working days (Mon–Sat) in the month
  days_present          integer NOT NULL DEFAULT 0,
  cl_days               integer NOT NULL DEFAULT 0,
  sl_days               integer NOT NULL DEFAULT 0,
  lop_days              integer NOT NULL DEFAULT 0,

  -- Earnings snapshot (monthly figures)
  basic                 numeric(10,2) NOT NULL DEFAULT 0,
  hra                   numeric(10,2) NOT NULL DEFAULT 0,
  da                    numeric(10,2) NOT NULL DEFAULT 0,
  special_allowance     numeric(10,2) NOT NULL DEFAULT 0,
  mobile_reimbursement  numeric(10,2) NOT NULL DEFAULT 0,
  other_reimbursements  numeric(10,2) NOT NULL DEFAULT 0,
  lta_this_month        numeric(10,2) NOT NULL DEFAULT 0,  -- HR marks which month LTA is paid

  gross_payable         numeric(10,2) NOT NULL DEFAULT 0,  -- after LOP deduction

  -- Deductions
  lop_deduction         numeric(10,2) NOT NULL DEFAULT 0,  -- (gross_monthly / working_days) × lop_days
  pt_deduction          numeric(10,2) NOT NULL DEFAULT 0,  -- Tamil Nadu Professional Tax
  tds_deduction         numeric(10,2) NOT NULL DEFAULT 0,  -- Section 192 (manual Phase 1)
  pf_employee           numeric(10,2) NOT NULL DEFAULT 0,  -- future
  esi_employee          numeric(10,2) NOT NULL DEFAULT 0,  -- future
  other_deductions      numeric(10,2) NOT NULL DEFAULT 0,  -- ad-hoc

  total_deductions      numeric(10,2) NOT NULL DEFAULT 0,
  net_payable           numeric(10,2) NOT NULL DEFAULT 0,

  -- Override
  is_locked             boolean NOT NULL DEFAULT false,  -- true after run is finalized
  override_note         text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE(payroll_run_id, employee_id)
);

ALTER TABLE payroll_slips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read payroll slips"
  ON payroll_slips FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage payroll slips"
  ON payroll_slips FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX idx_payroll_slips_run ON payroll_slips(payroll_run_id);
CREATE INDEX idx_payroll_slips_employee ON payroll_slips(employee_id);
