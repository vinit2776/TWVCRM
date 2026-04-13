-- =====================================================================
-- Migration 00094: Vendor-item price memory
-- One row per vendor × item pair — always the last confirmed PO price.
-- Built automatically; never manually entered.
-- =====================================================================

CREATE TABLE IF NOT EXISTS vendor_item_prices (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     UUID          NOT NULL REFERENCES procurement_vendors(id) ON DELETE CASCADE,
  item_id       UUID          NOT NULL REFERENCES procurement_items(id)   ON DELETE CASCADE,
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  gst_rate      NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (gst_rate >= 0 AND gst_rate <= 28),
  last_po_id    UUID          REFERENCES purchase_orders(id) ON DELETE SET NULL,
  last_po_number TEXT,
  updated_by    UUID          NOT NULL REFERENCES users(id),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_vendor_item UNIQUE (vendor_id, item_id)
);

-- Fast lookup by item (for bulk fetch on MR approval / PO form)
CREATE INDEX IF NOT EXISTS idx_vip_item   ON vendor_item_prices(item_id);
-- Fast lookup by vendor (for vendor detail price list tab)
CREATE INDEX IF NOT EXISTS idx_vip_vendor ON vendor_item_prices(vendor_id);

ALTER TABLE vendor_item_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON vendor_item_prices
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT ALL ON vendor_item_prices TO service_role;
