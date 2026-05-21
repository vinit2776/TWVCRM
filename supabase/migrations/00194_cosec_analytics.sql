-- ─────────────────────────────────────────────────────────────────────────────
-- 00194_cosec_analytics.sql
--
-- Adds deep analytics support to the COSEC access control integration:
--
--  1. access_logs enrichment — entity_name + denial_reason stored at write time
--  2. cosec_presence — live IN/OUT state per entity (who is inside right now)
--  3. Indexes for analytics query patterns (heatmap, attendance, presence)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Enrich access_logs at write time ──────────────────────────────────────

-- Store resolved display name so analytics queries don't need multi-table joins.
ALTER TABLE access_logs
  ADD COLUMN IF NOT EXISTS entity_name text;

-- Human-readable denial reason derived from raw_event_id on insert.
ALTER TABLE access_logs
  ADD COLUMN IF NOT EXISTS denial_reason text;

-- ── 2. Live presence state ───────────────────────────────────────────────────
-- One row per (device, entity): updated on every IN / OUT event.
-- is_inside = true from last IN until next OUT.

CREATE TABLE IF NOT EXISTS cosec_presence (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id        uuid NOT NULL REFERENCES cosec_devices(id) ON DELETE CASCADE,
  entity_id        uuid NOT NULL,
  entity_name      text NOT NULL,
  user_type        cosec_user_type NOT NULL,
  is_inside        boolean NOT NULL DEFAULT false,
  last_entry_at    timestamptz,
  last_exit_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, entity_id)
);

ALTER TABLE cosec_presence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read cosec_presence"
  ON cosec_presence FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated manage cosec_presence"
  ON cosec_presence FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Indexes for analytics
CREATE INDEX IF NOT EXISTS idx_cosec_presence_device     ON cosec_presence(device_id);
CREATE INDEX IF NOT EXISTS idx_cosec_presence_entity     ON cosec_presence(entity_id);
CREATE INDEX IF NOT EXISTS idx_cosec_presence_is_inside  ON cosec_presence(is_inside) WHERE is_inside = true;

-- Richer access_logs indexes for heatmap + attendance queries
CREATE INDEX IF NOT EXISTS idx_access_logs_event_time_dir
  ON access_logs(event_time DESC, direction);

CREATE INDEX IF NOT EXISTS idx_access_logs_entity_event_time
  ON access_logs(entity_id, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_access_logs_device_event_time
  ON access_logs(device_id, event_time DESC);

-- ── 3. Helper view: today's access summary per entity ────────────────────────
-- Used by the attendance query; materialisable later if needed.
CREATE OR REPLACE VIEW v_access_daily AS
SELECT
  al.device_id,
  al.entity_id,
  al.entity_name,
  al.user_type,
  date_trunc('day', al.event_time AT TIME ZONE 'Asia/Kolkata') AS access_date,
  COUNT(*) FILTER (WHERE al.direction = 'IN')     AS entries,
  COUNT(*) FILTER (WHERE al.direction = 'OUT')    AS exits,
  COUNT(*) FILTER (WHERE al.direction = 'DENIED') AS denials,
  MIN(al.event_time) FILTER (WHERE al.direction = 'IN')  AS first_entry,
  MAX(al.event_time) FILTER (WHERE al.direction = 'OUT') AS last_exit
FROM access_logs al
GROUP BY 1, 2, 3, 4, 5;
