-- The WiFi network name printed in the voucher email ("Connect to the WiFi network: …").
-- NULL means the standard name ("Workvilla Clients"); set per location on the Vouchers page.
-- Existing RLS on locations is unchanged (reads: authenticated; writes: admin/manager/IT manager).
ALTER TABLE locations ADD COLUMN IF NOT EXISTS wifi_ssid text;

COMMENT ON COLUMN locations.wifi_ssid IS
  'WiFi network name shown in voucher emails for this location. NULL = "Workvilla Clients".';

-- Rollback: ALTER TABLE locations DROP COLUMN IF EXISTS wifi_ssid;
