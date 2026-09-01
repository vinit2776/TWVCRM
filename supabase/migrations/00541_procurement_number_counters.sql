-- ============================================================
-- Migration 00541: Company-scoped, race-safe PR/PO/bill numbering
-- ============================================================
-- purchase_requests.pr_number and purchase_orders.po_number were generated
-- in application code via a SELECT count(*)-style approach (generatePrNumber
-- in requests/route.ts, generatePoNumber in orders/route.ts) — the same race
-- pattern already fixed for vendor_bills in
-- 00397_fix_vendor_bill_number_race.sql. Since a company_id dimension has to
-- be added to numbering anyway (MedWorks Plus needs its own MWP-* series),
-- this migration extends the same BEFORE INSERT counter-table pattern to all
-- three documents, closing the pre-existing race as a byproduct, and moves
-- vendor_bill_number_counters onto the same (company_id, year_month) key.

-- ── purchase_request_number_counters ──────────────────────────
CREATE TABLE IF NOT EXISTS purchase_request_number_counters (
  company_id UUID NOT NULL REFERENCES companies(id),
  year_month TEXT NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, year_month)
);

ALTER TABLE purchase_request_number_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view purchase_request_number_counters"
  ON purchase_request_number_counters FOR SELECT
  USING (auth.uid() IS NOT NULL);

INSERT INTO purchase_request_number_counters (company_id, year_month, last_seq)
SELECT
  company_id,
  substring(pr_number FROM 'PR-(\d{4})-\d+') AS year_month,
  MAX(CAST(substring(pr_number FROM 'PR-\d{4}-(\d+)') AS INTEGER)) AS last_seq
FROM purchase_requests
WHERE pr_number ~ '^PR-\d{4}-\d+$'
GROUP BY company_id, substring(pr_number FROM 'PR-(\d{4})-\d+')
ON CONFLICT (company_id, year_month) DO UPDATE
  SET last_seq = GREATEST(purchase_request_number_counters.last_seq, EXCLUDED.last_seq);

CREATE OR REPLACE FUNCTION generate_purchase_request_number()
RETURNS TRIGGER AS $$
DECLARE
  v_ym     TEXT;
  v_seq    INTEGER;
  v_prefix TEXT;
BEGIN
  IF NEW.pr_number IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT pr_prefix INTO v_prefix FROM companies WHERE id = NEW.company_id;
  v_ym := to_char(now(), 'YYMM');

  INSERT INTO purchase_request_number_counters (company_id, year_month, last_seq)
  VALUES (NEW.company_id, v_ym, 1)
  ON CONFLICT (company_id, year_month) DO UPDATE SET last_seq = purchase_request_number_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;

  NEW.pr_number := v_prefix || '-' || v_ym || '-' || LPAD(v_seq::TEXT, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_generate_purchase_request_number ON purchase_requests;
CREATE TRIGGER trg_generate_purchase_request_number
  BEFORE INSERT ON purchase_requests
  FOR EACH ROW
  EXECUTE FUNCTION generate_purchase_request_number();

-- ── purchase_order_number_counters ────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_order_number_counters (
  company_id UUID NOT NULL REFERENCES companies(id),
  year_month TEXT NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, year_month)
);

ALTER TABLE purchase_order_number_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view purchase_order_number_counters"
  ON purchase_order_number_counters FOR SELECT
  USING (auth.uid() IS NOT NULL);

INSERT INTO purchase_order_number_counters (company_id, year_month, last_seq)
SELECT
  company_id,
  substring(po_number FROM 'PO-(\d{4})-\d+') AS year_month,
  MAX(CAST(substring(po_number FROM 'PO-\d{4}-(\d+)') AS INTEGER)) AS last_seq
FROM purchase_orders
WHERE po_number ~ '^PO-\d{4}-\d+$'
GROUP BY company_id, substring(po_number FROM 'PO-(\d{4})-\d+')
ON CONFLICT (company_id, year_month) DO UPDATE
  SET last_seq = GREATEST(purchase_order_number_counters.last_seq, EXCLUDED.last_seq);

CREATE OR REPLACE FUNCTION generate_purchase_order_number()
RETURNS TRIGGER AS $$
DECLARE
  v_ym     TEXT;
  v_seq    INTEGER;
  v_prefix TEXT;
BEGIN
  IF NEW.po_number IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT po_prefix INTO v_prefix FROM companies WHERE id = NEW.company_id;
  v_ym := to_char(now(), 'YYMM');

  INSERT INTO purchase_order_number_counters (company_id, year_month, last_seq)
  VALUES (NEW.company_id, v_ym, 1)
  ON CONFLICT (company_id, year_month) DO UPDATE SET last_seq = purchase_order_number_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;

  NEW.po_number := v_prefix || '-' || v_ym || '-' || LPAD(v_seq::TEXT, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_generate_purchase_order_number ON purchase_orders;
CREATE TRIGGER trg_generate_purchase_order_number
  BEFORE INSERT ON purchase_orders
  FOR EACH ROW
  EXECUTE FUNCTION generate_purchase_order_number();

-- ── vendor_bill_number_counters: move onto (company_id, year_month) ──
DO $$
DECLARE
  v_workvilla_id UUID;
BEGIN
  SELECT id INTO v_workvilla_id FROM companies WHERE brand_name = 'Workvilla';

  ALTER TABLE vendor_bill_number_counters ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
  UPDATE vendor_bill_number_counters SET company_id = v_workvilla_id WHERE company_id IS NULL;
  ALTER TABLE vendor_bill_number_counters ALTER COLUMN company_id SET NOT NULL;

  ALTER TABLE vendor_bill_number_counters DROP CONSTRAINT IF EXISTS vendor_bill_number_counters_pkey;
  ALTER TABLE vendor_bill_number_counters ADD PRIMARY KEY (company_id, year_month);
END $$;

CREATE OR REPLACE FUNCTION generate_vendor_bill_number()
RETURNS TRIGGER AS $$
DECLARE
  v_ym     TEXT;
  v_seq    INTEGER;
  v_prefix TEXT;
BEGIN
  IF NEW.bill_number IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT bill_prefix INTO v_prefix FROM companies WHERE id = NEW.company_id;
  v_ym := to_char(now(), 'YYMM');

  INSERT INTO vendor_bill_number_counters (company_id, year_month, last_seq)
  VALUES (NEW.company_id, v_ym, 1)
  ON CONFLICT (company_id, year_month) DO UPDATE SET last_seq = vendor_bill_number_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;

  NEW.bill_number := v_prefix || '-' || v_ym || '-' || LPAD(v_seq::TEXT, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
