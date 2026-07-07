-- unifi_device_labels: lets ops staff attach a friendly label (and optionally
-- link to a contract) to a UniFi client MAC address, so "unknown device" in
-- the Network > Devices tab can become "John's laptop — Contract #123".
--
-- Purely additive — does not touch the existing known-devices/occupancy/
-- device-activity routes, which continue to talk to UniFi directly. This
-- table is joined client-side against that live data.

CREATE TABLE IF NOT EXISTS unifi_device_labels (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  UUID        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  mac          TEXT        NOT NULL,
  label        TEXT        NOT NULL,
  contract_id  UUID        REFERENCES contracts(id) ON DELETE SET NULL,
  created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, mac)
);

CREATE INDEX IF NOT EXISTS idx_unifi_device_labels_contract ON unifi_device_labels(contract_id);

CREATE TRIGGER update_unifi_device_labels_updated_at
  BEFORE UPDATE ON unifi_device_labels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE unifi_device_labels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read unifi_device_labels"
  ON unifi_device_labels FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert unifi_device_labels"
  ON unifi_device_labels FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update unifi_device_labels"
  ON unifi_device_labels FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete unifi_device_labels"
  ON unifi_device_labels FOR DELETE USING (auth.uid() IS NOT NULL);
