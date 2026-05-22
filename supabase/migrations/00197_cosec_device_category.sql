-- Replace is_entry_point boolean with device_category enum.
--
-- device_category values:
--   entry_point    — building entrance/exit door; contract members receive
--                    permanent biometric + NFC card enrollment here.
--   business_centre — conference rooms, meeting rooms, co-working amenity
--                    spaces; access is temporary and booking-driven (PIN only).
--
-- Migrates existing is_entry_point data:
--   true  → 'entry_point'
--   false → 'business_centre'
-- then drops the old boolean.

ALTER TABLE cosec_devices
  ADD COLUMN IF NOT EXISTS device_category text NOT NULL DEFAULT 'entry_point'
  CHECK (device_category IN ('entry_point', 'business_centre'));

-- Backfill from is_entry_point if the column exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cosec_devices' AND column_name = 'is_entry_point'
  ) THEN
    UPDATE cosec_devices
    SET device_category = CASE WHEN is_entry_point THEN 'entry_point' ELSE 'business_centre' END;

    ALTER TABLE cosec_devices DROP COLUMN is_entry_point;
  END IF;
END $$;

COMMENT ON COLUMN cosec_devices.device_category IS
  'entry_point: permanent member enrollment (biometric/card). '
  'business_centre: temporary booking-based PIN access only.';
