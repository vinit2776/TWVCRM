-- ============================================================
-- 00271: AMC → Asset Bridge
--
-- Adds asset_id FK to amc_service_events so each AMC visit
-- can be linked to a specific facility asset.
-- Also adds asset_id to purchase_orders (AMC contract → asset link).
-- ============================================================

-- ---------------------------------------------------------------------------
-- 1. Add asset_id to amc_service_events
-- ---------------------------------------------------------------------------

ALTER TABLE amc_service_events
  ADD COLUMN IF NOT EXISTS asset_id UUID REFERENCES facility_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_amc_service_events_asset
  ON amc_service_events(asset_id) WHERE asset_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Add asset_id to purchase_orders (AMC contract level link)
-- ---------------------------------------------------------------------------

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS linked_asset_id UUID REFERENCES facility_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_linked_asset
  ON purchase_orders(linked_asset_id) WHERE linked_asset_id IS NOT NULL;

COMMENT ON COLUMN purchase_orders.linked_asset_id IS
  'For AMC service POs: the primary asset this contract covers. Events inherit this by default.';
