-- ============================================================
-- Migration 00127: Floor in-charges per location
-- ============================================================
-- Each location can designate up to 2 in-charge users (typically with
-- the floor_manager role, though any user is permitted). They become
-- the primary recipients for:
--   - Cleaning alerts on guest checkout (replacing the broad
--     admin/manager/floor_manager broadcast that buried real owners
--     under noise)
--   - Headcount-due push notifications (instead of pushing to every
--     floor_manager regardless of which centre is missing data)
--
-- Two nullable FK columns chosen over a junction table because the
-- relationship is hard-capped at 2 — a junction would over-engineer
-- a list that never grows.
-- ============================================================

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS incharge_user_id_1 UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS incharge_user_id_2 UUID REFERENCES users(id) ON DELETE SET NULL;

-- Indexes for the reverse lookup (which locations does this user run?)
-- — used by the headcount push and the cleaning-email recipient query.
CREATE INDEX IF NOT EXISTS idx_locations_incharge_user_id_1
  ON locations(incharge_user_id_1) WHERE incharge_user_id_1 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_locations_incharge_user_id_2
  ON locations(incharge_user_id_2) WHERE incharge_user_id_2 IS NOT NULL;

-- Sanity: don't let the same user occupy both slots — that's a data
-- error, never an intent. (NULLs stay allowed in either slot.)
ALTER TABLE locations
  DROP CONSTRAINT IF EXISTS locations_incharges_distinct;
ALTER TABLE locations
  ADD CONSTRAINT locations_incharges_distinct
  CHECK (
    incharge_user_id_1 IS NULL
    OR incharge_user_id_2 IS NULL
    OR incharge_user_id_1 <> incharge_user_id_2
  );
