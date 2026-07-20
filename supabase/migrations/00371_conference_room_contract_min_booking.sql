-- Contract-holder minimum booking duration for conference/meeting rooms.
-- Non-contract (walk-in) customers keep using the existing min_booking_minutes column.
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS min_booking_minutes_contract INTEGER DEFAULT 30;
