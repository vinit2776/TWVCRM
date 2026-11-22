-- Settings for the enquiry escalation ladder (the cron that alerts staff about an enquiry nobody has
-- touched). `enquiry_escalation_mode`: 'dry_run' only reports what it would send, 'live' sends,
-- 'off' does nothing. It starts as a preview. `enquiry_escalation_effective_from`: only enquiries
-- received on or after this moment are ever chased, so applying this never alerts about the backlog.
-- Rollback:
--   DELETE FROM app_settings WHERE key IN ('enquiry_escalation_mode', 'enquiry_escalation_effective_from');
INSERT INTO app_settings (key, value)
VALUES ('enquiry_escalation_mode', 'dry_run')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_settings (key, value)
VALUES ('enquiry_escalation_effective_from', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO NOTHING;
