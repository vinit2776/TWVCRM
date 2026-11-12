-- ============================================================
-- Migration 00540: Scope locations + procurement to company_id
-- ============================================================
-- Adds company_id to locations, purchase_requests, purchase_orders,
-- vendor_bills, and department_budgets. All existing rows predate
-- multi-company support and are backfilled to Workvilla.
--
-- vendor_bills needs its own explicit company_id (not just inherited via
-- po_id -> purchase_orders.location_id) because po_id is nullable — a bill
-- can be created from just vendor_id + invoice_date + total_amount with no
-- linked PO and therefore no location to derive company from.

DO $$
DECLARE
  v_workvilla_id UUID;
BEGIN
  SELECT id INTO v_workvilla_id FROM companies WHERE brand_name = 'Workvilla';

  -- ── locations ──────────────────────────────────────────────
  ALTER TABLE locations ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
  UPDATE locations SET company_id = v_workvilla_id WHERE company_id IS NULL;
  ALTER TABLE locations ALTER COLUMN company_id SET NOT NULL;

  -- ── purchase_requests ──────────────────────────────────────
  ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
  UPDATE purchase_requests SET company_id = v_workvilla_id WHERE company_id IS NULL;
  ALTER TABLE purchase_requests ALTER COLUMN company_id SET NOT NULL;

  -- ── purchase_orders ────────────────────────────────────────
  ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
  UPDATE purchase_orders SET company_id = v_workvilla_id WHERE company_id IS NULL;
  ALTER TABLE purchase_orders ALTER COLUMN company_id SET NOT NULL;

  -- ── vendor_bills ───────────────────────────────────────────
  ALTER TABLE vendor_bills ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
  UPDATE vendor_bills SET company_id = v_workvilla_id WHERE company_id IS NULL;
  ALTER TABLE vendor_bills ALTER COLUMN company_id SET NOT NULL;

  -- ── department_budgets ─────────────────────────────────────
  ALTER TABLE department_budgets ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
  UPDATE department_budgets SET company_id = v_workvilla_id WHERE company_id IS NULL;
  ALTER TABLE department_budgets ALTER COLUMN company_id SET NOT NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_locations_company        ON locations(company_id);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_company ON purchase_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_company   ON purchase_orders(company_id);
CREATE INDEX IF NOT EXISTS idx_vendor_bills_company      ON vendor_bills(company_id);
CREATE INDEX IF NOT EXISTS idx_department_budgets_company ON department_budgets(company_id);

-- Rebuild department_budgets uniqueness to include company_id — see
-- 00099_fix_department_budgets_unique.sql for why these are partial
-- indexes rather than a single composite UNIQUE (NULL != NULL semantics).
DROP INDEX IF EXISTS department_budgets_dept_global_unique;
DROP INDEX IF EXISTS department_budgets_dept_location_unique;

CREATE UNIQUE INDEX IF NOT EXISTS department_budgets_company_dept_global_unique
  ON department_budgets (company_id, department)
  WHERE location_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS department_budgets_company_dept_location_unique
  ON department_budgets (company_id, department, location_id)
  WHERE location_id IS NOT NULL;
