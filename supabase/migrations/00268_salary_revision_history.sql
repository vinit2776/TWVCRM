-- Salary revision history: every UPDATE to employee_salary_definitions
-- is captured here via a BEFORE UPDATE trigger.
-- The current definition row always holds the live/latest values.

CREATE TABLE employee_salary_definition_history (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id           uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_from        date NOT NULL,
  effective_to          date NOT NULL,
  basic                 numeric(10,2),
  hra                   numeric(10,2),
  da                    numeric(10,2),
  special_allowance     numeric(10,2),
  lta_annual            numeric(10,2),
  mobile_reimbursement  numeric(10,2),
  other_reimbursements  numeric(10,2),
  tds_monthly_amount    numeric(10,2),
  pan_number            text,
  captured_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE employee_salary_definition_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read salary history"
  ON employee_salary_definition_history FOR SELECT TO authenticated USING (true);

CREATE INDEX idx_salary_history_employee
  ON employee_salary_definition_history(employee_id, effective_from DESC);

-- ── Trigger: capture old row before every UPDATE ─────────────────────────────
-- effective_to logic:
--   • If effective_from changes → effective_to = NEW.effective_from - 1 day
--   • If effective_from unchanged (HR updated amounts, kept same start date)
--       → effective_to = CURRENT_DATE - 1  (meaning "was effective until yesterday")

CREATE OR REPLACE FUNCTION capture_salary_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO employee_salary_definition_history (
    employee_id, effective_from, effective_to,
    basic, hra, da, special_allowance, lta_annual,
    mobile_reimbursement, other_reimbursements,
    tds_monthly_amount, pan_number
  ) VALUES (
    OLD.employee_id,
    OLD.effective_from,
    CASE
      WHEN NEW.effective_from <> OLD.effective_from
        THEN NEW.effective_from - 1
      ELSE CURRENT_DATE - 1
    END,
    OLD.basic, OLD.hra, OLD.da, OLD.special_allowance, OLD.lta_annual,
    OLD.mobile_reimbursement, OLD.other_reimbursements,
    OLD.tds_monthly_amount, OLD.pan_number
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_capture_salary_revision
BEFORE UPDATE ON employee_salary_definitions
FOR EACH ROW
WHEN (
  OLD.basic IS DISTINCT FROM NEW.basic OR
  OLD.hra IS DISTINCT FROM NEW.hra OR
  OLD.da IS DISTINCT FROM NEW.da OR
  OLD.special_allowance IS DISTINCT FROM NEW.special_allowance OR
  OLD.lta_annual IS DISTINCT FROM NEW.lta_annual OR
  OLD.mobile_reimbursement IS DISTINCT FROM NEW.mobile_reimbursement OR
  OLD.other_reimbursements IS DISTINCT FROM NEW.other_reimbursements OR
  OLD.tds_monthly_amount IS DISTINCT FROM NEW.tds_monthly_amount
)
EXECUTE FUNCTION capture_salary_revision();
