-- Add a short human-readable device code to cosec_devices
-- Format: TWV-D-NNN (zero-padded 3-digit sequence, global across all locations)

ALTER TABLE cosec_devices
  ADD COLUMN IF NOT EXISTS device_code TEXT UNIQUE;

-- Sequence for the numeric part
CREATE SEQUENCE IF NOT EXISTS cosec_device_code_seq START WITH 1 INCREMENT BY 1;

-- Backfill existing devices in creation order
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn
  FROM cosec_devices
  WHERE device_code IS NULL
)
UPDATE cosec_devices d
SET device_code = 'TWV-D-' || LPAD(o.rn::text, 3, '0')
FROM ordered o
WHERE d.id = o.id;

-- Advance the sequence past the backfilled values so next insert continues correctly.
-- setval() errors on 0 (sequence minvalue is 1), which a freshly created sequence
-- already satisfies for an empty table, so only advance it when there's a nonzero count.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM cosec_devices WHERE device_code IS NOT NULL;
  IF v_count > 0 THEN
    PERFORM setval('cosec_device_code_seq', v_count);
  END IF;
END $$;

-- Trigger function: auto-assign device_code on INSERT if not provided
CREATE OR REPLACE FUNCTION assign_cosec_device_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.device_code IS NULL THEN
    NEW.device_code := 'TWV-D-' || LPAD(nextval('cosec_device_code_seq')::text, 3, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cosec_device_code ON cosec_devices;
CREATE TRIGGER trg_cosec_device_code
  BEFORE INSERT ON cosec_devices
  FOR EACH ROW EXECUTE FUNCTION assign_cosec_device_code();

-- Make the column NOT NULL now that all rows are populated
ALTER TABLE cosec_devices
  ALTER COLUMN device_code SET NOT NULL;
