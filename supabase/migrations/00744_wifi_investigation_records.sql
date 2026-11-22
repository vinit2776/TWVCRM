-- Wi-Fi investigation records (docs/plans/wifi-device-history-and-lookup.md, PR 1).
--
-- Lets staff answer "who was connected to the network at time T, from public IP X"
-- long after the UniFi console has forgotten. Four tables:
--
--   wifi_device_assignments   which person / seat / voucher a device (MAC) belonged to,
--                             and for what period. Append-only history: reassigning a
--                             device closes the open row and opens a new one.
--   wifi_session_log          one row per Wi-Fi session (MAC, private IP, start, end,
--                             access point), copied from the console before it ages out.
--   center_public_ip_history  the center's public IP over time, so a police-supplied IP
--                             can be confirmed as ours at that time.
--   wifi_investigation_log    who looked up or exported what. Cannot be edited or deleted.
--
-- All four identify individuals' devices and activity, so they are readable only by
-- admin, it_manager and it_technician. Nothing user-facing writes them: the capture
-- cron and the lookup routes use the service role. Capture is switched off by
-- app_settings.wifi_investigation_enabled until Vinit turns it on (retention and
-- disclosure rules are to be confirmed first). Retention is 12 months, enforced by
-- wifi_investigation_purge() from the daily cron.
--
-- Rollback:
--   DROP FUNCTION wifi_investigation_purge(timestamptz);
--   DROP FUNCTION wifi_record_public_ip(uuid, text, timestamptz);
--   DROP FUNCTION wifi_reassign_device(uuid, text, uuid, uuid, integer, uuid, text, timestamptz);
--   DROP TABLE wifi_investigation_log, center_public_ip_history, wifi_session_log, wifi_device_assignments;
--   DELETE FROM app_settings WHERE key = 'wifi_investigation_enabled';

-- ── wifi_device_assignments ───────────────────────────────────────────────────
CREATE TABLE wifi_device_assignments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id         uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  -- Lower-case, colon separated, as UniFi reports it.
  mac                 text        NOT NULL,
  contract_id         uuid        REFERENCES contracts(id) ON DELETE SET NULL,
  contract_member_id  uuid        REFERENCES contract_members(id) ON DELETE SET NULL,
  seat_number         integer,
  voucher_issuance_id uuid        REFERENCES voucher_issuances(id) ON DELETE SET NULL,
  source              text        NOT NULL CHECK (source IN ('voucher_guest', 'adhoc_voucher', 'manual_label')),
  valid_from          timestamptz NOT NULL,
  -- NULL while the assignment is current.
  valid_to            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

-- A device has at most one current assignment.
CREATE UNIQUE INDEX uq_wifi_device_assignments_open
  ON wifi_device_assignments (location_id, mac) WHERE valid_to IS NULL;
CREATE INDEX idx_wifi_device_assignments_mac
  ON wifi_device_assignments (location_id, mac, valid_from);
CREATE INDEX idx_wifi_device_assignments_member
  ON wifi_device_assignments (contract_member_id) WHERE contract_member_id IS NOT NULL;

-- ── wifi_session_log ──────────────────────────────────────────────────────────
CREATE TABLE wifi_session_log (
  location_id      uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  mac              text        NOT NULL,
  assoc_time       timestamptz NOT NULL,
  -- NULL while the console reports the session as still open; re-captured until it closes.
  disassoc_time    timestamptz,
  duration_seconds integer,
  -- Private (LAN) address. Nullable: not every console response carries it.
  ip               text,
  hostname         text,
  ap_mac           text,
  essid            text,
  is_guest         boolean,
  rx_bytes         bigint      NOT NULL DEFAULT 0,
  tx_bytes         bigint      NOT NULL DEFAULT 0,
  captured_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, mac, assoc_time)
);

CREATE INDEX idx_wifi_session_log_time ON wifi_session_log (location_id, assoc_time);
CREATE INDEX idx_wifi_session_log_end  ON wifi_session_log (location_id, disassoc_time);
CREATE INDEX idx_wifi_session_log_ip   ON wifi_session_log (location_id, ip, assoc_time) WHERE ip IS NOT NULL;

-- ── center_public_ip_history ──────────────────────────────────────────────────
CREATE TABLE center_public_ip_history (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  ip          text        NOT NULL,
  first_seen  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL,
  CHECK (last_seen >= first_seen)
);

CREATE INDEX idx_center_public_ip_history_loc ON center_public_ip_history (location_id, first_seen DESC);
CREATE INDEX idx_center_public_ip_history_ip  ON center_public_ip_history (ip, first_seen);

-- ── wifi_investigation_log ────────────────────────────────────────────────────
CREATE TABLE wifi_investigation_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        REFERENCES users(id) ON DELETE SET NULL,
  role          text        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('lookup', 'export_csv', 'export_cover')),
  -- What was searched: public IP, time, window. Never contains customer personal data.
  query         jsonb       NOT NULL DEFAULT '{}',
  case_ref      text,
  -- An admin authorises themselves; an IT user names an admin. Checked by the route.
  authorised_by uuid        REFERENCES users(id) ON DELETE SET NULL,
  row_counts    jsonb       NOT NULL DEFAULT '{}',
  content_hash  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wifi_investigation_log_time ON wifi_investigation_log (created_at DESC);

-- The log is evidence of who looked at what. Nobody, service role included, may
-- change or remove a row through normal statements.
CREATE FUNCTION wifi_investigation_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wifi_investigation_log is append-only';
END;
$$;

CREATE TRIGGER wifi_investigation_log_no_update_delete
  BEFORE UPDATE OR DELETE ON wifi_investigation_log
  FOR EACH ROW EXECUTE FUNCTION wifi_investigation_log_immutable();
CREATE TRIGGER wifi_investigation_log_no_truncate
  BEFORE TRUNCATE ON wifi_investigation_log
  FOR EACH STATEMENT EXECUTE FUNCTION wifi_investigation_log_immutable();

-- ── RLS: the three allowed roles can read; nothing user-facing writes ─────────
ALTER TABLE wifi_device_assignments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wifi_session_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE center_public_ip_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE wifi_investigation_log   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wifi_device_assignments_select" ON wifi_device_assignments
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role IN ('admin', 'it_manager', 'it_technician')));
CREATE POLICY "wifi_session_log_select" ON wifi_session_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role IN ('admin', 'it_manager', 'it_technician')));
CREATE POLICY "center_public_ip_history_select" ON center_public_ip_history
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role IN ('admin', 'it_manager', 'it_technician')));
CREATE POLICY "wifi_investigation_log_select" ON wifi_investigation_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role IN ('admin', 'it_manager', 'it_technician')));

-- ── Setting: capture is off until switched on ─────────────────────────────────
INSERT INTO app_settings (key, value) VALUES ('wifi_investigation_enabled', 'false')
  ON CONFLICT (key) DO NOTHING;

-- ── wifi_reassign_device ──────────────────────────────────────────────────────
-- Makes (location, mac) belong to the given person/seat/voucher from p_valid_from.
-- No-op when the open row already says the same. Otherwise closes the open row at
-- p_valid_from and opens a new one, in one transaction. History is never edited.
CREATE FUNCTION wifi_reassign_device(
  p_location_id         uuid,
  p_mac                 text,
  p_contract_id         uuid,
  p_contract_member_id  uuid,
  p_seat_number         integer,
  p_voucher_issuance_id uuid,
  p_source              text,
  p_valid_from          timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_open wifi_device_assignments%ROWTYPE;
  v_id   uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_location_id::text || ':' || p_mac, 0));

  SELECT * INTO v_open FROM wifi_device_assignments
   WHERE location_id = p_location_id AND mac = p_mac AND valid_to IS NULL;

  IF FOUND THEN
    IF v_open.contract_id IS NOT DISTINCT FROM p_contract_id
       AND v_open.contract_member_id IS NOT DISTINCT FROM p_contract_member_id
       AND v_open.seat_number IS NOT DISTINCT FROM p_seat_number
       AND v_open.voucher_issuance_id IS NOT DISTINCT FROM p_voucher_issuance_id THEN
      RETURN v_open.id;
    END IF;
    UPDATE wifi_device_assignments
       SET valid_to = GREATEST(p_valid_from, v_open.valid_from)
     WHERE id = v_open.id;
  END IF;

  INSERT INTO wifi_device_assignments
    (location_id, mac, contract_id, contract_member_id, seat_number, voucher_issuance_id, source, valid_from)
  VALUES
    (p_location_id, p_mac, p_contract_id, p_contract_member_id, p_seat_number, p_voucher_issuance_id, p_source,
     GREATEST(p_valid_from, COALESCE(v_open.valid_from, p_valid_from)))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ── wifi_record_public_ip ─────────────────────────────────────────────────────
-- Extends the current row while the IP is unchanged, opens a new one when it changes.
CREATE FUNCTION wifi_record_public_ip(
  p_location_id uuid,
  p_ip          text,
  p_seen_at     timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_last center_public_ip_history%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pubip:' || p_location_id::text, 0));

  SELECT * INTO v_last FROM center_public_ip_history
   WHERE location_id = p_location_id ORDER BY first_seen DESC LIMIT 1;

  IF FOUND AND v_last.ip = p_ip THEN
    UPDATE center_public_ip_history SET last_seen = GREATEST(last_seen, p_seen_at) WHERE id = v_last.id;
  ELSE
    INSERT INTO center_public_ip_history (location_id, ip, first_seen, last_seen)
    VALUES (p_location_id, p_ip, p_seen_at, p_seen_at);
  END IF;
END;
$$;

-- ── wifi_investigation_purge ──────────────────────────────────────────────────
-- Deletes capture records older than the retention cut-off. Never touches
-- wifi_investigation_log. Returns how many rows went from each table.
CREATE FUNCTION wifi_investigation_purge(p_before timestamptz)
RETURNS TABLE (sessions bigint, assignments bigint, public_ips bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s bigint; a bigint; p bigint;
BEGIN
  DELETE FROM wifi_session_log WHERE assoc_time < p_before;
  GET DIAGNOSTICS s = ROW_COUNT;
  DELETE FROM wifi_device_assignments WHERE valid_to IS NOT NULL AND valid_to < p_before;
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM center_public_ip_history WHERE last_seen < p_before;
  GET DIAGNOSTICS p = ROW_COUNT;
  RETURN QUERY SELECT s, a, p;
END;
$$;

-- Service role only: these change records that identify people.
REVOKE ALL ON FUNCTION wifi_reassign_device(uuid, text, uuid, uuid, integer, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wifi_record_public_ip(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wifi_investigation_purge(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wifi_reassign_device(uuid, text, uuid, uuid, integer, uuid, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION wifi_record_public_ip(uuid, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION wifi_investigation_purge(timestamptz) TO service_role;
