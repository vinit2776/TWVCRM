-- The app was overriding invoice_number on every insert with a value computed
-- from `SELECT COUNT(*) + 1` in application code (src/app/api/invoices/route.ts),
-- which is racy under concurrent invoice creation and can violate the UNIQUE
-- constraint on proforma_invoices.invoice_number. This left the existing
-- generate_invoice_number() trigger (00001_initial_schema.sql, 00018_security_fixes.sql)
-- dead code, since it only fires WHEN (NEW.invoice_number IS NULL).
--
-- Fix: the app now leaves invoice_number unset and lets this trigger assign it
-- atomically within the INSERT. Keep the existing "INV-" prefix/format already
-- live in production data instead of switching to the trigger's old "TWV-PI-"
-- format, so invoice numbering stays continuous.
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(invoice_number FROM 'INV-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM proforma_invoices;
  NEW.invoice_number := 'INV-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
