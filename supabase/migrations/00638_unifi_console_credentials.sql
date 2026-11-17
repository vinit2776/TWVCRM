-- Per-console UniFi API keys.
--
-- Until now every UniFi location shared the single UNIFI_API_KEY env var, which
-- only works when one UniFi account owns every console. The Perungudi console
-- (MWP-TWV gateway) is owned by a different UniFi account, so its key has to
-- be stored separately. The cloud connector (api.ui.com) only proxies for the
-- console's owner, so one key per console is the model.
--
-- Keyed by console id (what unifiRequest already receives) rather than by
-- location, so no caller has to change. The key is AES-256-GCM encrypted
-- (src/lib/crypto-secrets.ts) before it reaches this table.
--
-- RLS is enabled with NO policies on purpose, unlike most tables here: reads
-- and writes happen only through the service-role client on the server. Many
-- routes read tables with the user's session, and ciphertext of an API key has
-- no business being readable from a browser.

CREATE TABLE IF NOT EXISTS unifi_console_credentials (
  console_id        TEXT PRIMARY KEY,
  api_key_encrypted TEXT NOT NULL,
  updated_by        UUID REFERENCES public.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TRIGGER update_unifi_console_credentials_updated_at
    BEFORE UPDATE ON unifi_console_credentials
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE unifi_console_credentials ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE unifi_console_credentials IS
  'Encrypted UniFi API key per console. Service-role only (no RLS policies by design). Falls back to the UNIFI_API_KEY env var when a console has no row.';

-- Rollback: DROP TABLE unifi_console_credentials;
