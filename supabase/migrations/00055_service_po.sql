-- ==========================================
-- Migration 00055: Service Purchase Orders
-- ==========================================
-- Adds support for service-type POs (e.g. generator hire, AMC contracts)
-- where payment is cycle-based rather than per-delivery.
--
-- Changes:
-- 1. purchase_orders  — adds po_type + service billing fields
-- 2. po_service_reports — new table for per-cycle service delivery confirmations
-- 3. vendor_bills     — adds service_report_id FK

-- ==========================================
-- 1. Extend purchase_orders
-- ==========================================

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS po_type              TEXT NOT NULL DEFAULT 'goods'
    CONSTRAINT purchase_orders_po_type_check CHECK (po_type IN ('goods', 'service')),
  ADD COLUMN IF NOT EXISTS service_start_date   DATE,
  ADD COLUMN IF NOT EXISTS billing_cycle        TEXT
    CONSTRAINT purchase_orders_billing_cycle_check CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly')),
  ADD COLUMN IF NOT EXISTS cycle_count          INTEGER,
  ADD COLUMN IF NOT EXISTS unit_cost_per_cycle  DECIMAL(12,2);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_po_type ON purchase_orders(po_type);

-- ==========================================
-- 2. po_service_reports
-- ==========================================

CREATE TABLE IF NOT EXISTS po_service_reports (
  id               UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  po_id            UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  cycle_number     INTEGER NOT NULL,
  period_from      DATE NOT NULL,
  period_to        DATE NOT NULL,
  report_file_url  TEXT,
  notes            TEXT,
  recorded_by      UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT po_service_reports_unique_cycle UNIQUE (po_id, cycle_number)
);

CREATE INDEX IF NOT EXISTS idx_po_service_reports_po ON po_service_reports(po_id);

ALTER TABLE po_service_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read po_service_reports" ON po_service_reports;
DROP POLICY IF EXISTS "Authenticated users can insert po_service_reports" ON po_service_reports;
DROP POLICY IF EXISTS "Authenticated users can update po_service_reports" ON po_service_reports;
DROP POLICY IF EXISTS "Authenticated users can delete po_service_reports" ON po_service_reports;

CREATE POLICY "Authenticated users can read po_service_reports"
  ON po_service_reports FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert po_service_reports"
  ON po_service_reports FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update po_service_reports"
  ON po_service_reports FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete po_service_reports"
  ON po_service_reports FOR DELETE USING (auth.uid() IS NOT NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.po_service_reports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.po_service_reports TO service_role;

-- ==========================================
-- 3. vendor_bills — add service_report_id
-- ==========================================

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS service_report_id UUID REFERENCES po_service_reports(id);

CREATE INDEX IF NOT EXISTS idx_vendor_bills_service_report ON vendor_bills(service_report_id);
