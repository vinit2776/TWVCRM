-- Activate CRM GST issuance mode.
--
-- 00244 introduced the GST-mode standby gate, seeded crm_gst_enabled='false'.
-- For the live business, GST invoices must keep issuing from the CRM exactly as
-- before the Tally work — so we activate CRM GST mode. Without this, deploying the
-- standby gate would send every newly-paid invoice to "standby" (no GST issued).
--
-- Tally Sync stays paused (tally_sync_enabled unchanged) — this only ensures the
-- CRM keeps doing what it does today. When you go live on Tally, you switch modes
-- from Admin → Tally Sync.

INSERT INTO app_settings (key, value)
VALUES ('crm_gst_enabled', 'true')
ON CONFLICT (key) DO UPDATE SET value = 'true';
