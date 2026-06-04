-- Seed crm_gst_enabled = 'false' (standby until the admin explicitly activates a mode).
-- tally_sync_enabled already exists via the Tally control flow — this adds its CRM counterpart.
INSERT INTO app_settings (key, value)
VALUES ('crm_gst_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
