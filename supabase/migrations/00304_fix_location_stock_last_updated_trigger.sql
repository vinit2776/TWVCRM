-- ==========================================
-- Migration 00304: Fix location_stock timestamp trigger
-- ==========================================
-- BUG: Migration 00078 attached the shared update_updated_at() trigger function
--      (which sets NEW.updated_at) to location_stock — but that table's column is
--      named `last_updated`, not `updated_at`. As a BEFORE UPDATE trigger, every
--      UPDATE to location_stock raised:
--          record "new" has no field "updated_at"
--      INSERTs were unaffected (the trigger only fires on UPDATE), so the first
--      time an item got a stock row it worked, but EVERY subsequent stock change
--      failed. In practice this silently broke all stock movement on existing
--      items: consumption logged but never decremented stock, and stock transfer
--      dispatch/receive failed outright. This has been broken since 00078.
--
-- FIX: Drop the mis-wired trigger and replace it with one that sets the correct
--      column (last_updated). Idempotent and safe to re-run.

DROP TRIGGER IF EXISTS update_location_stock_updated_at ON location_stock;

CREATE OR REPLACE FUNCTION update_last_updated_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_updated = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_location_stock_last_updated ON location_stock;

CREATE TRIGGER update_location_stock_last_updated
  BEFORE UPDATE ON location_stock
  FOR EACH ROW EXECUTE FUNCTION update_last_updated_column();

-- Rollback:
--   DROP TRIGGER IF EXISTS update_location_stock_last_updated ON location_stock;
--   (The old trigger was non-functional; no need to recreate it.)
