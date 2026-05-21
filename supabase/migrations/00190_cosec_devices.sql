-- COSEC biometric device registry (one per location)
CREATE TABLE cosec_devices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id           uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  label                 text NOT NULL DEFAULT 'Main Entrance',
  device_ip             text NOT NULL,
  device_port           integer NOT NULL DEFAULT 80,
  device_password       text NOT NULL,
  is_enabled            boolean NOT NULL DEFAULT true,
  -- Event polling state — updated by the cosec-events cron
  last_roll_over_count  integer NOT NULL DEFAULT 0,
  last_seq_number       integer NOT NULL DEFAULT 0,
  last_polled_at        timestamptz,
  last_ping_at          timestamptz,
  last_ping_success     boolean,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE(location_id, label)
);

ALTER TABLE cosec_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read cosec_devices"
  ON cosec_devices FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin/manager can manage cosec_devices"
  ON cosec_devices FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- COSEC provisioned users — one row per entity per device
CREATE TYPE cosec_user_type AS ENUM ('contract', 'employee', 'booking');
CREATE TYPE cosec_enrollment_status AS ENUM (
  'pending',
  'provisioned',
  'biometric_enrolled',
  'card_enrolled',
  'fully_enrolled',
  'blocked',
  'deleted'
);

CREATE TABLE cosec_access_users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id             uuid NOT NULL REFERENCES cosec_devices(id) ON DELETE RESTRICT,
  cosec_user_id         text NOT NULL,   -- "C...", "E...", "B..." — 15 char max
  cosec_ref_id          integer NOT NULL, -- numeric, used in event logs
  user_type             cosec_user_type NOT NULL,
  entity_id             uuid NOT NULL,   -- contract_id / employee_id / booking_id
  enrollment_status     cosec_enrollment_status NOT NULL DEFAULT 'pending',
  nfc_card_number       text,
  access_pin            text,            -- walk-in bookings only
  valid_until           date,
  provisioned_at        timestamptz,
  biometric_enrolled_at timestamptz,
  card_enrolled_at      timestamptz,
  blocked_at            timestamptz,
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE(device_id, cosec_user_id)
);

ALTER TABLE cosec_access_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read cosec_access_users"
  ON cosec_access_users FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin/manager can manage cosec_access_users"
  ON cosec_access_users FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX idx_cosec_access_users_entity ON cosec_access_users(entity_id);
CREATE INDEX idx_cosec_access_users_device ON cosec_access_users(device_id, enrollment_status);
CREATE INDEX idx_cosec_access_users_ref ON cosec_access_users(device_id, cosec_ref_id);
