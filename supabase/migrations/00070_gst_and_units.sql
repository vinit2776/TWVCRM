-- ==========================================
-- Migration 00068: GST support + new item units
-- ==========================================
-- 1. Add new unit values (month, quarter, year, nos, can, ton) to item_unit enum
-- 2. Add gst_rate to procurement_items (default rate per catalog item)
-- 3. Add gst_rate + gst_amount to purchase_order_items
-- 4. Add GST totals to purchase_orders
-- ==========================================

-- 1. New unit enum values
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'month';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'quarter';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'year';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'nos';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'can';
ALTER TYPE item_unit ADD VALUE IF NOT EXISTS 'ton';

-- 1b. New department enum value
ALTER TYPE procurement_department ADD VALUE IF NOT EXISTS 'asset';

-- 2. Catalog items: default GST rate
ALTER TABLE procurement_items
  ADD COLUMN IF NOT EXISTS gst_rate DECIMAL(5,2) DEFAULT 0;

-- 3. PO line items: per-item GST
ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS gst_rate DECIMAL(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gst_amount DECIMAL(12,2) DEFAULT 0;

-- 4. Purchase orders: GST totals
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS total_gst_amount DECIMAL(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_amount_with_gst DECIMAL(12,2);

-- Backfill: existing POs have no GST, so total_with_gst = subtotal
UPDATE purchase_orders
  SET total_amount_with_gst = total_ordered_amount
  WHERE total_amount_with_gst IS NULL;
