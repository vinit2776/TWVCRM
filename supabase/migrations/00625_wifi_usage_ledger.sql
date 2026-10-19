-- Wi-Fi usage ledger (Customer Value, phase 4b: docs/customer-value-tab-spec.md, section 5.7).
--
-- The UniFi console only keeps hourly usage for about 7 days and daily usage for
-- about 90, so anything older is gone for good. These two tables are the CRM's own
-- copy, filled by the hourly cron /api/cron/wifi-ledger-capture, so a customer's
-- Wi-Fi history exists once the Value tab is ready to show it. They are only ever
-- written by that cron (service role); nothing user-facing writes them.
--
-- wifi_client_hourly  one row per device (MAC) per hour: bytes down and up.
--                     Hours with no traffic have no row.
-- wifi_site_hourly    one row per center per hour: total Wi-Fi bytes and the
--                     number of connected devices. It exists for every hour the
--                     capture ran, so "no client rows" can be told apart from
--                     "capture was down".
--
-- A MAC address identifies a device, so both tables are admin-read only. Which
-- customer a device belongs to is worked out at read time, never stored here.
--
-- Rollback:
--   DROP TABLE wifi_site_hourly;
--   DROP TABLE wifi_client_hourly;

CREATE TABLE wifi_client_hourly (
  location_id  uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  -- Lower-case, colon separated, as UniFi reports it.
  mac          text        NOT NULL,
  -- Start of the hour (UTC instant).
  hour_start   timestamptz NOT NULL,
  rx_bytes     bigint      NOT NULL DEFAULT 0,
  tx_bytes     bigint      NOT NULL DEFAULT 0,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, mac, hour_start)
);

CREATE INDEX idx_wifi_client_hourly_hour ON wifi_client_hourly (location_id, hour_start);

CREATE TABLE wifi_site_hourly (
  location_id  uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  hour_start   timestamptz NOT NULL,
  wlan_bytes   bigint      NOT NULL DEFAULT 0,
  num_sta      integer,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, hour_start)
);

ALTER TABLE wifi_client_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE wifi_site_hourly   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wifi_client_hourly_admin_select" ON wifi_client_hourly
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = 'admin'));

CREATE POLICY "wifi_site_hourly_admin_select" ON wifi_site_hourly
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = 'admin'));
