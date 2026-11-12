-- 00620_enquiry_auto_resolve_cutoff.sql
-- Enquiries now resolve themselves from what happens in the CRM (contract activated ->
-- Converted, lead lost -> Not interested, 21 quiet days -> No response). This is the
-- cut-off: ONLY enquiries received on or after it are ever auto-resolved, so past
-- enquiries and their conversion numbers are never rewritten. Their stage is still shown.
--
-- Set to the time this migration is applied. Change it by updating the row (ISO timestamp).
-- If the row is missing or unparseable, nothing is auto-resolved (the fail-safe direction).
INSERT INTO app_settings (key, value)
VALUES ('enquiry_auto_resolve_effective_from', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO NOTHING;

-- Rollback: DELETE FROM app_settings WHERE key = 'enquiry_auto_resolve_effective_from';
