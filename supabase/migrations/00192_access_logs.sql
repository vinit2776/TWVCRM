-- Access logs — all IN/OUT/DENIED events pulled from COSEC devices
CREATE TABLE access_logs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id           uuid NOT NULL REFERENCES cosec_devices(id) ON DELETE RESTRICT,
  cosec_ref_id        integer NOT NULL,  -- raw from device event
  user_type           cosec_user_type,   -- resolved from cosec_access_users
  entity_id           uuid,              -- resolved contract/employee/booking id
  direction           text,              -- 'IN' | 'OUT' | 'DENIED'
  raw_event_id        integer NOT NULL,  -- device event-id code
  event_time          timestamptz NOT NULL,
  device_seq_number   integer NOT NULL,
  roll_over_count     integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE access_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read access_logs"
  ON access_logs FOR SELECT TO authenticated USING (true);

-- Only service role writes (via cron)
CREATE POLICY "Service role can insert access_logs"
  ON access_logs FOR INSERT TO authenticated WITH CHECK (true);

CREATE INDEX idx_access_logs_entity    ON access_logs(entity_id, event_time DESC);
CREATE INDEX idx_access_logs_device    ON access_logs(device_id, roll_over_count, device_seq_number);
CREATE INDEX idx_access_logs_ref_time  ON access_logs(cosec_ref_id, event_time DESC);
CREATE INDEX idx_access_logs_time      ON access_logs(event_time DESC);
