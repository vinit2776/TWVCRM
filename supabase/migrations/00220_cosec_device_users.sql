-- Cache of users as they exist on each COSEC device (including those provisioned
-- outside the CRM). Populated by the sync-users API endpoint.
-- cosec_ref_id = the numeric ref-user-id set on the device
-- cosec_user_id = the string user-id (may equal cosec_ref_id for directly-provisioned users)

CREATE TABLE IF NOT EXISTS cosec_device_users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id        UUID NOT NULL REFERENCES cosec_devices(id) ON DELETE CASCADE,
  cosec_ref_id     INTEGER NOT NULL,
  cosec_user_id    TEXT NOT NULL,
  name             TEXT,
  nfc_card         TEXT,
  has_pin          BOOLEAN NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (device_id, cosec_ref_id)
);

ALTER TABLE cosec_device_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users can read cosec_device_users"
  ON cosec_device_users FOR SELECT TO authenticated USING (TRUE);

-- Index for fast log-page lookups
CREATE INDEX IF NOT EXISTS idx_cosec_device_users_device_ref
  ON cosec_device_users (device_id, cosec_ref_id);
