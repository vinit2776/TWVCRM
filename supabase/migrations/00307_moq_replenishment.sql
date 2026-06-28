-- ============================================================
-- Migration 00307: MOQ-driven two-tier replenishment
-- ------------------------------------------------------------
-- Adds a hidden central "hub" (HQ) that holds bulk stock, plus
-- per-location and per-item min/max levels that drive refill
-- suggestions (HQ -> location transfers). Suggestion-only: no
-- auto-dispatch, no vendor PO automation.
--
-- All changes are additive / non-destructive:
--   * locations.is_hub             — flags the central store; hidden from normal pickers
--   * location_stock.max_level     — refill target (min = existing reorder_level)
--   * procurement_items.default_*  — catalog defaults that pre-fill new location rows
--   * stock_transfers.origin       — 'manual' | 'replenishment' (for the lifecycle view)
--
-- Rollback: drop the four columns and delete the seeded hub row.
-- ============================================================

-- 1. Central hub flag on locations
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS is_hub BOOLEAN NOT NULL DEFAULT false;

-- 2. Refill target on per-location stock (min stays as reorder_level)
ALTER TABLE location_stock
  ADD COLUMN IF NOT EXISTS max_level NUMERIC;

-- 3. Catalog-level defaults (pre-fill new per-location rows; NULL = unset)
ALTER TABLE procurement_items
  ADD COLUMN IF NOT EXISTS default_reorder_level NUMERIC,
  ADD COLUMN IF NOT EXISTS default_max_level     NUMERIC;

-- 4. Where a transfer originated — surfaced in the transfer lifecycle view
ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';

-- 5. Seed the central hub (inactive + is_hub so it stays out of normal lists).
--    Idempotent on is_hub — the app resolves "the hub" by is_hub = true,
--    so no hardcoded UUID is needed and re-running is safe.
INSERT INTO locations (name, code, address, city, is_active, is_hub)
SELECT 'HQ — Central Store', 'HQHUB', 'Central warehouse', 'HQ', false, true
WHERE NOT EXISTS (SELECT 1 FROM locations WHERE is_hub = true);
