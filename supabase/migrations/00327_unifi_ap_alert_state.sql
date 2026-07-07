-- unifi_ap_alert_state: tracks the last-known online/offline state of each
-- UniFi access point per location, so the AP-down alerting cron
-- (/api/cron/unifi-ap-health) only emails on a state TRANSITION rather than
-- re-alerting every run while an AP stays down.

CREATE TABLE IF NOT EXISTS unifi_ap_alert_state (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id    UUID        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  mac            TEXT        NOT NULL,
  ap_name        TEXT,
  last_status    TEXT        NOT NULL CHECK (last_status IN ('online', 'offline')),
  down_since     TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, mac)
);

CREATE TRIGGER update_unifi_ap_alert_state_updated_at
  BEFORE UPDATE ON unifi_ap_alert_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE unifi_ap_alert_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read unifi_ap_alert_state"
  ON unifi_ap_alert_state FOR SELECT USING (auth.uid() IS NOT NULL);
