-- ============================================================
-- Migration 00671: One vendor invoice shared across several PO bills
--
-- A vendor sometimes sends a single invoice for work done under several POs.
-- Each PO still gets its own bill (its share of the invoice); the bills are
-- tied together by a group that remembers the invoice's real total, so:
--   * the shares can never add up to more than the invoice, and
--   * the total belongs to no single bill (rejecting or withdrawing the first
--     bill must not lose it).
--
-- Rollback: DROP TRIGGER trg_vendor_bill_group_allocation ON vendor_bills;
--           DROP TRIGGER trg_vendor_invoice_group_total ON vendor_invoice_groups;
--           ALTER TABLE vendor_bills DROP COLUMN invoice_group_id;
--           DROP TABLE vendor_invoice_groups;
--           DROP FUNCTION enforce_vendor_bill_group_allocation, enforce_vendor_invoice_group_total;
-- ============================================================

CREATE TABLE IF NOT EXISTS vendor_invoice_groups (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL REFERENCES companies(id),
  vendor_id          UUID NOT NULL REFERENCES procurement_vendors(id),
  -- As first typed, for display.
  invoice_number     TEXT NOT NULL,
  -- Lower-case, no spaces: what "the same invoice" means.
  invoice_number_key TEXT NOT NULL,
  -- What the vendor's invoice adds up to. The bills below carry shares of it.
  invoice_total      NUMERIC(12,2) NOT NULL CHECK (invoice_total > 0),
  created_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, vendor_id, invoice_number_key)
);

ALTER TABLE vendor_invoice_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read vendor invoice groups" ON vendor_invoice_groups;
CREATE POLICY "Authenticated can read vendor invoice groups"
  ON vendor_invoice_groups FOR SELECT
  TO authenticated
  USING (true);

-- Writes go through the server (service role) only.
GRANT SELECT ON public.vendor_invoice_groups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_invoice_groups TO service_role;

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS invoice_group_id UUID REFERENCES vendor_invoice_groups(id);

CREATE INDEX IF NOT EXISTS idx_vendor_bills_invoice_group
  ON vendor_bills (invoice_group_id) WHERE invoice_group_id IS NOT NULL;

-- A live bill's share can't push the group past the invoice total. Locking the
-- group row first makes two people joining at once take turns, so both can't
-- pass the "₹80,000 left" check.
CREATE OR REPLACE FUNCTION enforce_vendor_bill_group_allocation()
RETURNS TRIGGER AS $$
DECLARE
  v_total     NUMERIC;
  v_allocated NUMERIC;
BEGIN
  SELECT invoice_total INTO v_total
    FROM vendor_invoice_groups WHERE id = NEW.invoice_group_id FOR UPDATE;

  SELECT COALESCE(SUM(total_amount), 0) INTO v_allocated
    FROM vendor_bills
   WHERE invoice_group_id = NEW.invoice_group_id
     AND approval_status NOT IN ('rejected', 'withdrawn')
     AND id <> NEW.id;

  IF v_allocated + NEW.total_amount > v_total + 0.01 THEN
    RAISE EXCEPTION 'SHARED_INVOICE_OVER_ALLOCATED: shares would total % against an invoice of %',
      v_allocated + NEW.total_amount, v_total;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendor_bill_group_allocation ON vendor_bills;
CREATE TRIGGER trg_vendor_bill_group_allocation
  BEFORE INSERT OR UPDATE OF total_amount, approval_status, invoice_group_id ON vendor_bills
  FOR EACH ROW
  WHEN (NEW.invoice_group_id IS NOT NULL AND NEW.approval_status NOT IN ('rejected', 'withdrawn'))
  EXECUTE FUNCTION enforce_vendor_bill_group_allocation();

-- The invoice total can't be lowered below what the live bills already hold.
CREATE OR REPLACE FUNCTION enforce_vendor_invoice_group_total()
RETURNS TRIGGER AS $$
DECLARE
  v_allocated NUMERIC;
BEGIN
  SELECT COALESCE(SUM(total_amount), 0) INTO v_allocated
    FROM vendor_bills
   WHERE invoice_group_id = NEW.id
     AND approval_status NOT IN ('rejected', 'withdrawn');

  IF NEW.invoice_total < v_allocated - 0.01 THEN
    RAISE EXCEPTION 'SHARED_INVOICE_TOTAL_BELOW_SHARES: invoice total % is below the % already on its bills',
      NEW.invoice_total, v_allocated;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendor_invoice_group_total ON vendor_invoice_groups;
CREATE TRIGGER trg_vendor_invoice_group_total
  BEFORE UPDATE OF invoice_total ON vendor_invoice_groups
  FOR EACH ROW
  EXECUTE FUNCTION enforce_vendor_invoice_group_total();
