-- ==========================================
-- Migration 00067: Add item_type to procurement_items
-- ==========================================
-- The API and UI support a goods/service toggle for catalog items,
-- but the column was never added to the table.
-- Default to 'goods' to match existing items.
-- ==========================================

ALTER TABLE procurement_items
  ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'goods';

-- Backfill: all existing items are goods
UPDATE procurement_items SET item_type = 'goods' WHERE item_type IS NULL;
