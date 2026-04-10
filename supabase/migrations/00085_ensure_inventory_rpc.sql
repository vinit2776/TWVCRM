-- =====================================================================
-- Migration 00085: Ensure upsert_location_stock RPC exists
--
-- This is a safety re-application of the RPC function that backs the
-- entire inventory system.  Running CREATE OR REPLACE is idempotent —
-- if the function already exists it is simply refreshed.
-- =====================================================================

-- Re-create the atomic stock-update function (idempotent)
CREATE OR REPLACE FUNCTION upsert_location_stock(
  p_location_id UUID,
  p_item_id     UUID,
  p_quantity_delta NUMERIC
) RETURNS VOID AS $$
BEGIN
  INSERT INTO location_stock (location_id, item_id, quantity_on_hand)
  VALUES (p_location_id, p_item_id, GREATEST(0, p_quantity_delta))
  ON CONFLICT (location_id, item_id)
  DO UPDATE SET
    quantity_on_hand = GREATEST(0, location_stock.quantity_on_hand + p_quantity_delta),
    last_updated     = NOW();
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Grant execute to authenticated users so the API can call it via
-- the standard supabase client (not just the service-role client).
GRANT EXECUTE ON FUNCTION upsert_location_stock(UUID, UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION upsert_location_stock(UUID, UUID, NUMERIC) TO service_role;
