-- ============================================================
-- Migration 00372: Transfer issuing-source location flag
-- ------------------------------------------------------------
-- Branch-initiated transfer requests (floor_manager/fms) need a fixed
-- single source location to send `from_location_id` to, without the
-- application code hardcoding a UUID or matching on location name.
-- This mirrors the existing locations.is_hub pattern used for MOQ
-- replenishment (00307), but is a distinct, real, active location —
-- not to be confused with that hidden virtual hub.
--
-- Rollback: drop the column.
-- ============================================================

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS is_issuing_source BOOLEAN NOT NULL DEFAULT false;

UPDATE locations
SET is_issuing_source = true
WHERE name = 'NUN 5th floor'
  AND NOT EXISTS (SELECT 1 FROM locations WHERE is_issuing_source = true);
