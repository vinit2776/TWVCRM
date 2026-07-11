-- Optional verification photo on a beverage log: a phone photo of the vending
-- machine's own counter/display, cross-checking the manually tapped drink
-- counts. One photo per log entry (not per drink), attached via a follow-up
-- upload after the log row already exists — see
-- POST /api/procurement/beverage-logs/[id]/photo.

ALTER TABLE beverage_logs ADD COLUMN IF NOT EXISTS photo_path TEXT;
ALTER TABLE beverage_logs ADD COLUMN IF NOT EXISTS photo_url TEXT;

COMMENT ON COLUMN beverage_logs.photo_path IS
  'Supabase Storage path (crm-documents bucket) for an optional verification photo of the vending machine display.';
COMMENT ON COLUMN beverage_logs.photo_url IS
  '5-year signed URL for the photo, cached at upload time (same pattern as facility_assets.photos).';
