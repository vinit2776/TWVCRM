-- Add proposal_amenity_icons to locations
-- Stores the ordered list of icon keys shown in the "Featured Amenities"
-- strip of the proposal PDF. Defaults to the original 4 icons so existing
-- locations are unaffected until a manager explicitly changes them.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS proposal_amenity_icons JSONB
    NOT NULL DEFAULT '["wifi","coffee","printer","meeting"]'::jsonb;
