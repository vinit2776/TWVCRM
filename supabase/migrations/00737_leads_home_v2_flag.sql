-- Switch for the new Leads navigation (daily tabs plus Buckets and Reports menus) and, in later
-- changes, the new Leads Home. Off by default: nothing changes for anyone until it is turned on.
-- Rollback:
--   DELETE FROM app_settings WHERE key = 'leads_home_v2_enabled';
INSERT INTO app_settings (key, value)
VALUES ('leads_home_v2_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
