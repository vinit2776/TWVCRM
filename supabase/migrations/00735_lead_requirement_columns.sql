-- Leads: keep the whole requirement a caller gives, not just the first location and type.
--
-- The call-in form already collects several locations and workspace types, a start date, a quoted
-- price and a place we have no centre in, but the lead stored only the first location and type and
-- the rest lived in the call's note text. These columns hold it as data so Home, jobs and proposals
-- can read it. The single-value columns (location_id, workspace_type, preferred_location) stay and
-- keep the first value: about ten readers depend on them.
--
-- Additive and idempotent. Rollback:
--   ALTER TABLE leads
--     DROP COLUMN IF EXISTS tenure_months, DROP COLUMN IF EXISTS start_date,
--     DROP COLUMN IF EXISTS quoted_per_seat, DROP COLUMN IF EXISTS other_area,
--     DROP COLUMN IF EXISTS workspace_types, DROP COLUMN IF EXISTS location_ids,
--     DROP COLUMN IF EXISTS extras;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS tenure_months integer CHECK (tenure_months IS NULL OR tenure_months BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS quoted_per_seat numeric(10,2) CHECK (quoted_per_seat IS NULL OR quoted_per_seat >= 0),
  ADD COLUMN IF NOT EXISTS other_area text,
  ADD COLUMN IF NOT EXISTS workspace_types text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS location_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS extras text[] NOT NULL DEFAULT '{}';

-- Backfill the lists from the single values so older leads read the same as new ones.
UPDATE leads SET workspace_types = ARRAY[workspace_type::text]
  WHERE workspace_type IS NOT NULL AND workspace_types = '{}';
UPDATE leads SET location_ids = ARRAY[location_id]
  WHERE location_id IS NOT NULL AND location_ids = '{}';
