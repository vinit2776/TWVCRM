-- ============================================================
-- Migration 00103: Vendor Bill Payment Batch Scheduling
-- ============================================================

-- ─── 1. Extend vendor_bills with batch scheduling fields ─────────────────────

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS payment_batch_type TEXT
    CONSTRAINT vendor_bills_payment_batch_type_check
    CHECK (payment_batch_type IN ('immediate', '15th', '25th')),
  ADD COLUMN IF NOT EXISTS payment_batch_date DATE,
  ADD COLUMN IF NOT EXISTS payment_batch_assigned_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS payment_batch_assigned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_vendor_bills_payment_batch_date
  ON vendor_bills(payment_batch_date)
  WHERE payment_batch_date IS NOT NULL;

-- ─── 2. Audit table for batch date overrides ─────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_bill_batch_changes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_bill_id    UUID NOT NULL REFERENCES vendor_bills(id) ON DELETE CASCADE,
  changed_by        UUID REFERENCES users(id),
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  old_batch_type    TEXT,
  new_batch_type    TEXT,
  old_batch_date    DATE,
  new_batch_date    DATE,
  reason            TEXT
);

CREATE INDEX IF NOT EXISTS idx_vb_batch_changes_bill
  ON vendor_bill_batch_changes(vendor_bill_id);

-- ─── 3. RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE vendor_bill_batch_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read vendor_bill_batch_changes"   ON vendor_bill_batch_changes;
DROP POLICY IF EXISTS "Authenticated users can insert vendor_bill_batch_changes" ON vendor_bill_batch_changes;

CREATE POLICY "Authenticated users can read vendor_bill_batch_changes"
  ON vendor_bill_batch_changes FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert vendor_bill_batch_changes"
  ON vendor_bill_batch_changes FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

GRANT SELECT, INSERT ON public.vendor_bill_batch_changes TO authenticated;
GRANT SELECT, INSERT ON public.vendor_bill_batch_changes TO service_role;
