-- Add source column to booking_feedbacks to distinguish staff vs customer submissions
ALTER TABLE booking_feedbacks
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'customer';

-- Backfill: staff submitted = has rated_by, customer submitted = rated_by is null
UPDATE booking_feedbacks SET source = 'staff' WHERE rated_by IS NOT NULL;
UPDATE booking_feedbacks SET source = 'customer' WHERE rated_by IS NULL;

-- Enforce valid values
ALTER TABLE booking_feedbacks
  ADD CONSTRAINT booking_feedbacks_source_check CHECK (source IN ('staff', 'customer'));

-- One staff + one customer feedback per booking (ignore if constraint already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booking_feedbacks_booking_source_unique'
  ) THEN
    ALTER TABLE booking_feedbacks
      ADD CONSTRAINT booking_feedbacks_booking_source_unique UNIQUE (booking_id, source);
  END IF;
END$$;
