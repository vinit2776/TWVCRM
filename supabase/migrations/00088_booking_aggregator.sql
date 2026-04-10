-- Add aggregator booking reference to bookings
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS aggregator_booking_id TEXT;
