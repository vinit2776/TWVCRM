-- Add attention_notes to facility_assets.
-- This is a sticky per-asset note that surfaces as a warning banner
-- on the asset detail page and in the AMC event / issue creation dialogs.
-- Intended for recurring observations like "belt is loose — check every visit".

ALTER TABLE facility_assets
  ADD COLUMN IF NOT EXISTS attention_notes TEXT;

COMMENT ON COLUMN facility_assets.attention_notes IS
  'Persistent technician note that surfaces as a warning on the asset page and in service dialogs (e.g. "belt is loose — check every visit").';
