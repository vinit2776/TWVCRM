-- Migration: 00009_booking_enhancements
-- Adds:
--   1. booker_phone column to bookings (mandatory contact number for the person booking)
--   2. refund_status + refund columns for no-show refund exception flow

-- 1. Add booker_phone to bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booker_phone VARCHAR(20);

-- 2. Add refund fields for no-show exception handling
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_status VARCHAR(20) DEFAULT NULL;
-- refund_status values: NULL (no refund), 'requested', 'approved', 'processed'
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_amount DECIMAL(12,2) DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_reason TEXT DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_approved_by UUID REFERENCES users(id) DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_approved_at TIMESTAMPTZ DEFAULT NULL;

-- 3. Index on booker_phone for phone search
CREATE INDEX IF NOT EXISTS idx_bookings_booker_phone ON bookings(booker_phone);
