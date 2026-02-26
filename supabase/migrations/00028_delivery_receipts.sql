-- Sprint 3.10: Delivery Challan / Receipt tracking for Purchase Orders

-- Delivery receipt header (one row per DC / delivery event)
CREATE TABLE po_delivery_receipts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id          UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  dc_number      TEXT,
  dc_date        DATE,
  file_url       TEXT,
  notes          TEXT,
  received_by    UUID NOT NULL REFERENCES users(id),
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-item quantities for each delivery receipt
CREATE TABLE po_delivery_receipt_items (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_receipt_id  UUID NOT NULL REFERENCES po_delivery_receipts(id) ON DELETE CASCADE,
  po_item_id           UUID NOT NULL REFERENCES purchase_order_items(id),
  qty_received         NUMERIC NOT NULL DEFAULT 0
);

-- Add quantity_received tracking to PO items (cumulative across all DCs)
ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS quantity_received NUMERIC NOT NULL DEFAULT 0;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_po_delivery_receipts_po_id
  ON po_delivery_receipts(po_id);

CREATE INDEX IF NOT EXISTS idx_po_receipt_items_receipt
  ON po_delivery_receipt_items(delivery_receipt_id);

-- RLS
ALTER TABLE po_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_delivery_receipt_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all" ON po_delivery_receipts
  FOR ALL TO authenticated USING (true);

CREATE POLICY "authenticated_all" ON po_delivery_receipt_items
  FOR ALL TO authenticated USING (true);
