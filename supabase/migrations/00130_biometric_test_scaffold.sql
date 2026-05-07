-- ============================================================
-- Biometric Device Test Scaffold
-- Minimal tables to validate eSSL F22 / ZKTeco ADMS push
-- before building the full Attendance / Payroll module.
--
-- Three tables:
--   biometric_devices     — auto-registered on first push
--   biometric_raw_punches — every ATTLOG record from device
--   biometric_user_map    — maps device PIN → CRM entity
-- ============================================================

-- ── 1. Device registry ──────────────────────────────────────
CREATE TABLE biometric_devices (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_number    text        UNIQUE NOT NULL,
  alias            text,                                           -- friendly name e.g. "TWV Koramangala - Entry"
  location_id      uuid        REFERENCES locations(id) ON DELETE SET NULL,
  firmware_version text,
  push_version     text,
  fp_count         int,                                           -- fingerprints currently enrolled on device
  last_seen_at     timestamptz,
  last_ip          text,
  is_active        boolean     NOT NULL DEFAULT true,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE biometric_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can manage biometric_devices"
  ON biometric_devices FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 2. Raw punch log (ATTLOG) ───────────────────────────────
-- Every single record the device pushes is stored here verbatim.
-- Status codes: 0=check-in  1=check-out  4=break-out  5=break-in
-- Verify codes: 0=pin  1=fingerprint  4=rfid-card  15=face
CREATE TABLE biometric_raw_punches (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_serial    text        NOT NULL,
  device_pin       text        NOT NULL,  -- user ID as enrolled on the device
  punch_time       timestamptz NOT NULL,
  status_code      smallint,              -- 0 in / 1 out / 4 break-out / 5 break-in
  verify_type      smallint,              -- 0 pin / 1 fingerprint / 4 card / 15 face
  work_code        text,
  raw_line         text,                  -- full raw tab-separated line for debugging
  -- resolved entity (populated async after punch arrives)
  entity_type      text,                  -- 'employee' | 'member' | 'booking' | 'guest'
  entity_id        uuid,
  entity_name      text,                  -- denormalised for quick display
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX biometric_raw_punches_device_time
  ON biometric_raw_punches (device_serial, punch_time DESC);
CREATE INDEX biometric_raw_punches_entity
  ON biometric_raw_punches (entity_type, entity_id);

ALTER TABLE biometric_raw_punches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read biometric_raw_punches"
  ON biometric_raw_punches FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 3. Device user map ──────────────────────────────────────
-- Maps a PIN (1–9999) on a specific device to a CRM entity.
-- During the test phase this is populated manually by admin.
-- During full build: auto-provisioned on contract/booking creation.
CREATE TABLE biometric_user_map (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_serial    text        NOT NULL,
  device_pin       text        NOT NULL,    -- numeric string, e.g. "3" or "1001"
  entity_type      text        NOT NULL,    -- 'employee' | 'member' | 'booking' | 'guest'
  entity_id        uuid        NOT NULL,
  display_name     text        NOT NULL,
  is_active        boolean     NOT NULL DEFAULT true,
  enrolled_at      timestamptz NOT NULL DEFAULT now(),
  notes            text,
  UNIQUE (device_serial, device_pin)
);

ALTER TABLE biometric_user_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can manage biometric_user_map"
  ON biometric_user_map FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Trigger: auto-resolve entity on new punch ───────────────
-- Looks up biometric_user_map and back-fills entity_* columns.
CREATE OR REPLACE FUNCTION resolve_biometric_punch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_map biometric_user_map%ROWTYPE;
BEGIN
  SELECT * INTO v_map
  FROM biometric_user_map
  WHERE device_serial = NEW.device_serial
    AND device_pin    = NEW.device_pin
    AND is_active     = true
  LIMIT 1;

  IF FOUND THEN
    NEW.entity_type := v_map.entity_type;
    NEW.entity_id   := v_map.entity_id;
    NEW.entity_name := v_map.display_name;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_resolve_biometric_punch
BEFORE INSERT ON biometric_raw_punches
FOR EACH ROW EXECUTE FUNCTION resolve_biometric_punch();

-- ── Realtime: enable for live test dashboard ────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE biometric_raw_punches;
ALTER PUBLICATION supabase_realtime ADD TABLE biometric_devices;
