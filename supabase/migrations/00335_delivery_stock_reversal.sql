-- =====================================================================
-- Migration 00335: Fix asymmetric delivery stock add/reverse
--
-- Problem: recording a delivery (POST) resolves the stock location as
-- po.location_id with a fallback to the linked PR's location_id, and
-- resolves the stock item as po_item.item_id with a fallback to the
-- linked PR item's item_id. Rejecting a delivery (DELETE) only used
-- po.location_id and po_item.item_id — so deliveries credited via
-- either fallback were never reversed, leaving phantom stock.
--
-- Fix: persist the resolved location/item on the delivery rows at
-- creation time so the rejection path reverses exactly what was added.
-- Legacy rows (NULL columns) are re-derived with the same fallback
-- chain in application code.
-- =====================================================================

-- Where stock was actually credited for this delivery
ALTER TABLE po_delivery_receipts
  ADD COLUMN IF NOT EXISTS stock_location_id UUID REFERENCES locations(id);

-- Which procurement item stock was actually credited against
ALTER TABLE po_delivery_receipt_items
  ADD COLUMN IF NOT EXISTS stock_item_id UUID REFERENCES procurement_items(id);

-- Atomic increment/decrement of purchase_order_items.quantity_received.
-- Replaces the read-then-write pattern in the deliveries route, which
-- could lose updates under concurrent deliveries. Floors at 0 to match
-- the previous reversal behaviour.
CREATE OR REPLACE FUNCTION increment_po_item_received(
  p_po_item_id UUID,
  p_po_id      UUID,
  p_delta      NUMERIC
) RETURNS VOID AS $$
BEGIN
  UPDATE purchase_order_items
  SET quantity_received = GREATEST(0, quantity_received + p_delta)
  WHERE id = p_po_item_id
    AND po_id = p_po_id;
END;
$$ LANGUAGE plpgsql SET search_path = public;

GRANT EXECUTE ON FUNCTION increment_po_item_received(UUID, UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION increment_po_item_received(UUID, UUID, NUMERIC) TO service_role;
