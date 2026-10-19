-- Wi-Fi daily usage ledger (Customer Value, phase 4b; follows 00625).
--
-- The UniFi console keeps daily per-device usage for about 90 days. 00625 copies the
-- hourly figures, which the console only keeps for 7 days, so on day one the
-- Wi-Fi history would be a week long. These two tables are filled by the same
-- hourly cron from the console's daily reports, so the roughly 90 days it still
-- holds are secured now instead of aging out.
--
-- wifi_client_daily  one row per device (MAC) per day: bytes down and up.
-- wifi_site_daily   one row per center per day: total Wi-Fi bytes and devices.
--
-- A day is the console's own bucket: it starts at IST midnight, which is 18:30 UTC
-- the day before, stored as that instant. Same rules as the hourly tables: only
-- the cron writes (service role), admin-read only, devices are never tied to a
-- customer here.
--
-- Rollback:
--   DROP TABLE wifi_site_daily;
--   DROP TABLE wifi_client_daily;

CREATE TABLE wifi_client_daily (
  location_id  uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  mac          text        NOT NULL,
  -- Start of the console's day bucket as reported (IST midnight = 18:30 UTC).
  day_start    timestamptz NOT NULL,
  rx_bytes     bigint      NOT NULL DEFAULT 0,
  tx_bytes     bigint      NOT NULL DEFAULT 0,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, mac, day_start)
);

CREATE INDEX idx_wifi_client_daily_day ON wifi_client_daily (location_id, day_start);

CREATE TABLE wifi_site_daily (
  location_id  uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  day_start    timestamptz NOT NULL,
  wlan_bytes   bigint      NOT NULL DEFAULT 0,
  num_sta      integer,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, day_start)
);

ALTER TABLE wifi_client_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE wifi_site_daily   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wifi_client_daily_admin_select" ON wifi_client_daily
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = 'admin'));

CREATE POLICY "wifi_site_daily_admin_select" ON wifi_site_daily
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = 'admin'));
