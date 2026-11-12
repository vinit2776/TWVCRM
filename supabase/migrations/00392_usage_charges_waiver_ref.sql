-- Human-readable approval reference for a waived usage charge.
--
-- Follows the same TWV-XX-NNNN convention (and MAX+regex generator shape)
-- as booking_number / statement_number / contract_payment_number, so a
-- waiver can be quoted to a member or in an audit the same way any other
-- document in this system is.
ALTER TABLE usage_charges
  ADD COLUMN IF NOT EXISTS waiver_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_charges_waiver_ref
  ON usage_charges(waiver_ref)
  WHERE waiver_ref IS NOT NULL;

-- Assign on the transition into 'waived', not on insert. Charges that are
-- born waived (a booking that lands inside its free monthly quota) have
-- waived_by NULL — those are quota markers, not write-offs, and must not
-- consume a reference number.
CREATE OR REPLACE FUNCTION generate_waiver_ref()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  IF NEW.status = 'waived'
     AND NEW.waived_by IS NOT NULL
     AND NEW.waiver_ref IS NULL THEN
    SELECT COALESCE(MAX(
      CAST(SUBSTRING(waiver_ref FROM 'TWV-WV-(\d+)') AS INTEGER)
    ), 0) + 1 INTO next_num FROM public.usage_charges;
    NEW.waiver_ref := 'TWV-WV-' || LPAD(next_num::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_usage_charges_waiver_ref ON usage_charges;
CREATE TRIGGER trg_usage_charges_waiver_ref
  BEFORE UPDATE ON usage_charges
  FOR EACH ROW
  WHEN (NEW.status = 'waived' AND OLD.status IS DISTINCT FROM 'waived')
  EXECUTE FUNCTION generate_waiver_ref();
