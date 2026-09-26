-- Login credentials for network-capable facility assets (modems, WiFi routers,
-- network printers, etc.) — the admin URL/port, username, and password used to
-- log into the device's own management interface. One row per asset.
--
-- The password is never stored in plaintext: the API layer encrypts it
-- (AES-256-GCM, see src/lib/crypto-secrets.ts) before it reaches this table,
-- and only decrypts it on an explicit, audited "reveal" request. SELECT is
-- open to any authenticated user (same as facility_assets itself) because the
-- stored password_encrypted value is useless without the server-only
-- encryption key — the real access boundary is the reveal endpoint's role
-- check, not this table's RLS.

CREATE TABLE IF NOT EXISTS facility_asset_credentials (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id           UUID NOT NULL UNIQUE REFERENCES facility_assets(id) ON DELETE CASCADE,
  admin_url          TEXT,
  username           TEXT,
  password_encrypted TEXT NOT NULL,
  updated_by         UUID REFERENCES public.users(id),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_facility_asset_credentials_asset ON facility_asset_credentials(asset_id);

DO $$ BEGIN
  CREATE TRIGGER update_facility_asset_credentials_updated_at
    BEFORE UPDATE ON facility_asset_credentials
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE facility_asset_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fac_asset_creds_select" ON facility_asset_credentials;
DROP POLICY IF EXISTS "fac_asset_creds_write"  ON facility_asset_credentials;

CREATE POLICY "fac_asset_creds_select" ON facility_asset_credentials
  FOR SELECT TO authenticated USING (true);

-- Write access is intentionally narrower than facility_assets itself --
-- limited to the roles who actually configure network gear, not every role
-- that can edit an asset's make/model/notes.
CREATE POLICY "fac_asset_creds_write" ON facility_asset_credentials
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'it_manager', 'it_technician')
        AND is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role IN ('admin', 'it_manager', 'it_technician')
        AND is_active = true
    )
  );
