-- Add Ruijie Cloud API as a third wifi_voucher_mode, alongside repository/unifi_api.
--
-- Nungambakkam Arcade runs Ruijie Reyee hardware (RAP2200(E) AP + NBR6210-E
-- gateway) managed via Ruijie Cloud, not UniFi. Ruijie's voucher API has no
-- revoke/disable endpoint as of 2026-07 — contract termination cannot yet
-- auto-kill a Ruijie voucher the way it does for unifi_api. See
-- docs/modules/vouchers.md for the full integration writeup and known gaps.

ALTER TABLE locations
  DROP CONSTRAINT IF EXISTS locations_wifi_voucher_mode_check;

ALTER TABLE locations
  ADD CONSTRAINT locations_wifi_voucher_mode_check
  CHECK (wifi_voucher_mode IN ('repository', 'unifi_api', 'ruijie_api'));

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS ruijie_group_id INTEGER;

COMMENT ON COLUMN locations.ruijie_group_id IS
  'Ruijie Cloud network group ID (site identifier). Set when wifi_voucher_mode = ruijie_api.';

ALTER TABLE voucher_issuances
  ADD COLUMN IF NOT EXISTS ruijie_voucher_uuid TEXT;

COMMENT ON COLUMN voucher_issuances.ruijie_voucher_uuid IS
  'Ruijie Cloud voucher uuid for this issuance. Set when wifi_voucher_mode = ruijie_api. No revoke API exists yet (2026-07) — see docs/modules/vouchers.md.';

ALTER TABLE voucher_issuances
  ADD COLUMN IF NOT EXISTS ruijie_code TEXT;

COMMENT ON COLUMN voucher_issuances.ruijie_code IS
  'Human-readable Ruijie voucher code. Populated for Ruijie-managed locations.';

-- Nungambakkam Arcade — confirmed groupId via live API test (2026-07-22).
UPDATE locations
  SET wifi_voucher_mode = 'ruijie_api',
      ruijie_group_id = 8921725
  WHERE name ILIKE '%nungambakkam%' AND name ILIKE '%arcade%';
