-- A service PO can cover several assets (a "combined" AMC PO): each PO line
-- carries the asset it covers. Single-asset POs set it too, so every reader can
-- look contracts up by line.
--
-- purchase_orders.linked_asset_id stays and holds the first asset, so older
-- readers and existing POs keep working. Nothing is backfilled: a PO whose
-- lines have no asset falls back to purchase_orders.linked_asset_id.

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS linked_asset_id UUID REFERENCES facility_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_order_items_linked_asset
  ON purchase_order_items(linked_asset_id) WHERE linked_asset_id IS NOT NULL;

COMMENT ON COLUMN purchase_order_items.linked_asset_id IS
  'Service / AMC POs only: the asset this line covers. A combined PO has one line per asset.';
