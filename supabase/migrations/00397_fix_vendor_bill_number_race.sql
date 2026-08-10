-- Fix vendor_bills.bill_number generation race condition.
--
-- The old scheme (src/lib/vendor-bills.ts) did SELECT COUNT(*) then computed
-- BILL-YYMM-NNN in the app before INSERT — a classic read-then-write race.
-- Two near-simultaneous requests (double-click, or two users creating a bill
-- around the same time) can both read the same count and collide on
-- vendor_bills_bill_number_key. Same bug class already fixed once for
-- support_tickets in 00079_fix_ticket_number_sequence.sql.
--
-- Fix: move numbering into a BEFORE INSERT trigger backed by a per-month
-- counter table. The INSERT ... ON CONFLICT DO UPDATE ... RETURNING below is
-- atomic under concurrency because Postgres serializes concurrent writers on
-- the same counter row.

CREATE TABLE IF NOT EXISTS vendor_bill_number_counters (
  year_month TEXT PRIMARY KEY,
  last_seq   INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE vendor_bill_number_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view vendor_bill_number_counters"
  ON vendor_bill_number_counters FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Seed counters from existing data so numbering continues where it left off.
INSERT INTO vendor_bill_number_counters (year_month, last_seq)
SELECT
  substring(bill_number FROM 'BILL-(\d{4})-\d+') AS year_month,
  MAX(CAST(substring(bill_number FROM 'BILL-\d{4}-(\d+)') AS INTEGER)) AS last_seq
FROM vendor_bills
WHERE bill_number ~ '^BILL-\d{4}-\d+$'
GROUP BY substring(bill_number FROM 'BILL-(\d{4})-\d+')
ON CONFLICT (year_month) DO UPDATE
  SET last_seq = GREATEST(vendor_bill_number_counters.last_seq, EXCLUDED.last_seq);

-- SECURITY DEFINER so the trigger can write to the counter table regardless
-- of the calling (authenticated) role's own grants/RLS — mirrors how the
-- table owner already bypasses RLS on vendor_bills itself.
CREATE OR REPLACE FUNCTION generate_vendor_bill_number()
RETURNS TRIGGER AS $$
DECLARE
  v_ym  TEXT;
  v_seq INTEGER;
BEGIN
  IF NEW.bill_number IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_ym := to_char(now(), 'YYMM');

  INSERT INTO vendor_bill_number_counters (year_month, last_seq)
  VALUES (v_ym, 1)
  ON CONFLICT (year_month) DO UPDATE SET last_seq = vendor_bill_number_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;

  NEW.bill_number := 'BILL-' || v_ym || '-' || LPAD(v_seq::TEXT, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_generate_vendor_bill_number ON vendor_bills;
CREATE TRIGGER trg_generate_vendor_bill_number
  BEFORE INSERT ON vendor_bills
  FOR EACH ROW
  EXECUTE FUNCTION generate_vendor_bill_number();
