-- Per-template health for the messaging monitor.
--
-- Why: messaging_health_state tracks one failure rate per CHANNEL. That hides a
-- single template failing completely — `gst_invoice_doc` sent 37 messages
-- between Aug and Nov 2026 and delivered none of them (a private-bucket URL that
-- Meta could not fetch, WhatsApp error 131053), while the WhatsApp channel as a
-- whole sat near a 6% failure rate and the monitor reported "ok" throughout.
--
-- Shape: { "<template>": { "status": "...", "alerted": "...", "at": "...",
--                          "sample": n, "failed": n } }
-- A jsonb column rather than a second table: the map is read and written whole,
-- on one row per channel, and never queried by template on its own.

ALTER TABLE messaging_health_state
  ADD COLUMN IF NOT EXISTS template_health JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN messaging_health_state.template_health IS
  'Per-template failure state for the trailing template window, including the last status alerted on, so a sustained single-template outage alerts once.';
