-- Add is_entry_point flag to cosec_devices.
--
-- Entry-point devices (Front/Back Entrance) are used for permanent contract
-- member enrollment (biometric + NFC card).
--
-- Booking devices (Conference Entrance, business-centre rooms) provide
-- temporary PIN-based access per booking only — members are NOT auto-
-- provisioned on these.
--
-- Default: true so existing devices are unaffected and admins can then
-- explicitly mark booking-only devices as false.

ALTER TABLE cosec_devices
  ADD COLUMN IF NOT EXISTS is_entry_point boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN cosec_devices.is_entry_point IS
  'true = members enrolled here permanently (biometric/card). '
  'false = booking-only device (temporary PIN access per booking).';
