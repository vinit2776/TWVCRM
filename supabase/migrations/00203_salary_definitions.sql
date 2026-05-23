-- Per-employee salary structure definition.
-- One row per employee (UNIQUE on employee_id).
-- effective_from allows future salary revision history if needed later.

CREATE TABLE employee_salary_definitions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id           uuid NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  effective_from        date NOT NULL,

  -- Monthly earnings (INR)
  basic                 numeric(10,2) NOT NULL DEFAULT 0,   -- PF-applicable base
  hra                   numeric(10,2) NOT NULL DEFAULT 0,
  da                    numeric(10,2) NOT NULL DEFAULT 0,
  special_allowance     numeric(10,2) NOT NULL DEFAULT 0,
  lta_annual            numeric(10,2) NOT NULL DEFAULT 0,   -- annual figure, NOT in monthly gross
  mobile_reimbursement  numeric(10,2) NOT NULL DEFAULT 0,   -- non-taxable
  other_reimbursements  numeric(10,2) NOT NULL DEFAULT 0,

  -- Monthly gross = basic + hra + da + special_allowance + mobile_reimbursement + other_reimbursements
  -- LTA is excluded from monthly gross (paid separately once or twice a year)

  -- TDS (Section 192) — manual amount for Phase 1; auto-slab compute in Phase 2
  tds_applicable        boolean NOT NULL DEFAULT false,
  tds_monthly_amount    numeric(10,2) NOT NULL DEFAULT 0,
  pan_number            text,   -- mirrors employees.pan_number, kept here for slip snapshots

  -- Future-ready — inactive until company crosses PF/ESI threshold
  pf_applicable         boolean NOT NULL DEFAULT false,
  esi_applicable        boolean NOT NULL DEFAULT false,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE employee_salary_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read salary definitions"
  ON employee_salary_definitions FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert salary definitions"
  ON employee_salary_definitions FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update salary definitions"
  ON employee_salary_definitions FOR UPDATE TO authenticated USING (true);
