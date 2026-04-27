-- ============================================================
-- Migration 00096: Department monthly procurement budgets
-- ============================================================

CREATE TABLE IF NOT EXISTS department_budgets (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  department     TEXT        NOT NULL,
  location_id    UUID        REFERENCES locations(id) ON DELETE CASCADE DEFAULT NULL,
  monthly_budget NUMERIC(12,2) NOT NULL CHECK (monthly_budget >= 0),
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  notes          TEXT        DEFAULT NULL,
  created_by     UUID        NOT NULL REFERENCES users(id),
  updated_by     UUID        REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (department, location_id)
);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_department_budgets_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_department_budgets_updated_at
  BEFORE UPDATE ON department_budgets
  FOR EACH ROW EXECUTE FUNCTION update_department_budgets_updated_at();

-- RLS
ALTER TABLE department_budgets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read department budgets"
  ON department_budgets FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert department budgets"
  ON department_budgets FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update department budgets"
  ON department_budgets FOR UPDATE
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can delete department budgets"
  ON department_budgets FOR DELETE
  TO authenticated USING (true);
