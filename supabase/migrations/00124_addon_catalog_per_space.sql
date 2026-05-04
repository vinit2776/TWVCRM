-- ============================================================
-- 00124: Per-space addon catalogue
--
-- The addon catalogue (Tea, Coffee, Print, Locker etc.) was originally
-- modelled as global + optional location-scoped overrides. Operations
-- has asked for charges to be specific to each space — premium meeting
-- rooms charge differently from open-desk areas, even within the same
-- location.
--
-- Approach (non-destructive):
--   1. Add `space_id` column (nullable, FK to spaces).
--   2. Existing rows (where space_id IS NULL) become "templates".
--      Admin can copy templates to any space with one click from the
--      new Charges tab on /spaces/[id].
--   3. Booking add-ons consumer queries by space_id from now on.
--
-- The legacy `location_id` column stays for now — unused by the new
-- per-space flow but kept to avoid breaking any caller we haven't
-- audited yet. Can be dropped in a later cleanup migration once the
-- per-space flow is verified in production.
-- ============================================================

ALTER TABLE addon_catalog
  ADD COLUMN IF NOT EXISTS space_id UUID REFERENCES spaces(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_addon_catalog_space ON addon_catalog(space_id);

COMMENT ON COLUMN addon_catalog.space_id IS
  'When set, this row is the catalogue for that specific space (conference room). '
  'When NULL, the row is a template that admin can copy to a space via /api/spaces/[id]/addon-catalog/seed-defaults.';
