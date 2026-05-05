-- Add num_attendees to bookings
-- Tracks the actual number of people attending a booking so the system can
-- issue the correct number of WiFi vouchers (1 voucher per 2 devices/attendees).
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS num_attendees INTEGER;
