-- Record which UniFi console (and which location) every voucher was issued on.
--
-- Until now a revoke / reveal / email re-derived the console from the *current*
-- location row. If a location's console is ever changed, or a voucher is
-- handled through the wrong location, the call lands on a different console
-- from the one that holds the voucher. Storing the console at issue time lets
-- every later call target exactly the console that issued it.
--
-- Additive only: nullable columns, no constraint changes. Existing rows are
-- backfilled from their location's current console (correct today: before
-- PR #1007 Nungambakkam was the only UniFi console in production).

ALTER TABLE voucher_issuances
  ADD COLUMN IF NOT EXISTS unifi_console_id TEXT,
  ADD COLUMN IF NOT EXISTS unifi_location_code TEXT;

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS unifi_voucher_console_id TEXT,
  ADD COLUMN IF NOT EXISTS unifi_voucher_location_code TEXT;

ALTER TABLE unifi_adhoc_voucher_links
  ADD COLUMN IF NOT EXISTS unifi_console_id TEXT,
  ADD COLUMN IF NOT EXISTS unifi_location_code TEXT;

COMMENT ON COLUMN voucher_issuances.unifi_console_id IS
  'UniFi cloud console the voucher was created on. Revoke/reveal/email use this, not the location''s current console.';
COMMENT ON COLUMN voucher_issuances.unifi_location_code IS
  'locations.code at issue time (also the prefix of the voucher note on the controller).';
COMMENT ON COLUMN contracts.unifi_voucher_console_id IS
  'UniFi cloud console that holds contracts.unifi_voucher_id.';
COMMENT ON COLUMN contracts.unifi_voucher_location_code IS
  'locations.code at the time contracts.unifi_voucher_id was issued.';

-- ── Backfill ────────────────────────────────────────────────────────────────

UPDATE voucher_issuances vi
SET unifi_console_id    = l.unifi_console_id,
    unifi_location_code = l.code
FROM (
  SELECT vi2.id AS issuance_id, COALESCE(c.location_id, b.location_id) AS location_id
  FROM voucher_issuances vi2
  LEFT JOIN contracts c ON c.id = vi2.contract_id
  LEFT JOIN bookings  b ON b.id = vi2.booking_id
  WHERE vi2.unifi_voucher_id IS NOT NULL
    AND vi2.unifi_console_id IS NULL
) src
JOIN locations l ON l.id = src.location_id
WHERE vi.id = src.issuance_id
  AND l.unifi_console_id IS NOT NULL;

UPDATE contracts c
SET unifi_voucher_console_id    = l.unifi_console_id,
    unifi_voucher_location_code = l.code
FROM locations l
WHERE l.id = c.location_id
  AND c.unifi_voucher_id IS NOT NULL
  AND c.unifi_voucher_console_id IS NULL
  AND l.unifi_console_id IS NOT NULL;

UPDATE unifi_adhoc_voucher_links k
SET unifi_console_id    = l.unifi_console_id,
    unifi_location_code = l.code
FROM locations l
WHERE l.id = k.location_id
  AND k.unifi_console_id IS NULL
  AND l.unifi_console_id IS NOT NULL;

-- Rollback:
--   ALTER TABLE voucher_issuances DROP COLUMN unifi_console_id, DROP COLUMN unifi_location_code;
--   ALTER TABLE contracts DROP COLUMN unifi_voucher_console_id, DROP COLUMN unifi_voucher_location_code;
--   ALTER TABLE unifi_adhoc_voucher_links DROP COLUMN unifi_console_id, DROP COLUMN unifi_location_code;
