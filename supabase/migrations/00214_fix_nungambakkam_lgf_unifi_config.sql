-- Fix Nungambakkam LGF UniFi configuration.
--
-- unifi_site_id was set to the site UUID (6342d5c...) from the old env-var
-- era. The API URL path requires the site slug ("default"), not the UUID.
-- Also populate unifi_console_id so the location row is self-contained
-- and doesn't depend on env-var fallbacks.

UPDATE locations
SET
  unifi_site_id    = 'default',
  unifi_console_id = '60223211830500000000068A48C60000000006D8E9030000000062D3FFFC:1779918393'
WHERE name ILIKE '%nungambakkam%' AND name ILIKE '%lgf%';
