-- Fix: 00207 was recorded in schema_migrations but columns were never applied.
-- This migration adds the missing columns idempotently.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS wifi_voucher_mode TEXT NOT NULL DEFAULT 'repository'
    CHECK (wifi_voucher_mode IN ('repository', 'unifi_api'));

COMMENT ON COLUMN locations.wifi_voucher_mode IS
  'repository = issue from pre-uploaded pool; unifi_api = generate on-demand via UniFi controller API.';

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS unifi_console_id TEXT;

COMMENT ON COLUMN locations.unifi_console_id IS
  'UniFi cloud console ID (UUID). Falls back to UNIFI_CONSOLE_ID env var when NULL.';

ALTER TABLE voucher_issuances
  ADD COLUMN IF NOT EXISTS unifi_voucher_id TEXT;

COMMENT ON COLUMN voucher_issuances.unifi_voucher_id IS
  'UniFi internal _id for this issuance. Set when wifi_voucher_mode = unifi_api.';

-- Set Nungambakkam LGF to UniFi API mode
UPDATE locations
  SET wifi_voucher_mode = 'unifi_api'
  WHERE name ILIKE '%nungambakkam%' AND name ILIKE '%lgf%';
