-- Energy slot alerts: tell staff when a location's power use strays from its usual
-- pattern for that 15-minute slot, without emailing on every slot.
--
-- Rollback (nothing else depends on these):
--   DROP TABLE energy_alert_events, energy_alert_episodes, energy_alert_rules;
--   DELETE FROM app_settings WHERE key = 'energy_alerts_cron_mode';
--
-- Three tables:
--   energy_alert_rules     one rule = one location + tolerance + who to email
--   energy_alert_episodes  one row per continuous problem (the unit of alerting)
--   energy_alert_events    every email decision (sent / test / held / muted), the audit trail
--
-- Episodes, not slots, are what get notified: the first email goes out when a
-- deviation has lasted `persist_slots`, and further emails are limited to a
-- worsening step or a back-off reminder (see src/lib/energy-alerts/engine.ts).

CREATE TABLE IF NOT EXISTS energy_alert_rules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  location_id       UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  -- A slot is "out" when it is more than this far from the usual for that slot...
  tolerance_pct     NUMERIC NOT NULL DEFAULT 5 CHECK (tolerance_pct >= 1 AND tolerance_pct <= 100),
  -- ...AND at least this many kW away, so a tiny night-time load cannot fire.
  min_kw            NUMERIC NOT NULL DEFAULT 2 CHECK (min_kw >= 0),
  direction         TEXT NOT NULL DEFAULT 'both' CHECK (direction IN ('both', 'high', 'low')),
  persist_slots     INT NOT NULL DEFAULT 2 CHECK (persist_slots BETWEEN 1 AND 8),
  recover_slots     INT NOT NULL DEFAULT 4 CHECK (recover_slots BETWEEN 1 AND 16),
  reminder_schedule TEXT NOT NULL DEFAULT 'std' CHECK (reminder_schedule IN ('std', '4h', 'none')),
  daily_cap         INT NOT NULL DEFAULT 6 CHECK (daily_cap BETWEEN 1 AND 24),
  recipients        TEXT[] NOT NULL DEFAULT '{}',
  send_resolved     BOOLEAN NOT NULL DEFAULT false,
  -- 'test' records what would have been sent and emails nobody.
  mode              TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
  enabled           BOOLEAN NOT NULL DEFAULT true,
  muted_until       TIMESTAMPTZ,
  -- Evaluation cursor: the last slot (start time) already judged, plus the
  -- not-yet-an-episode streak carried between runs.
  last_slot_ts      TIMESTAMPTZ,
  streak_slots      INT NOT NULL DEFAULT 0,
  streak_dir        SMALLINT NOT NULL DEFAULT 0,
  streak_kwh        NUMERIC NOT NULL DEFAULT 0,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_energy_alert_rules_location ON energy_alert_rules (location_id);

CREATE TABLE IF NOT EXISTS energy_alert_episodes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id        UUID NOT NULL REFERENCES energy_alert_rules(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  direction      SMALLINT NOT NULL CHECK (direction IN (-1, 1)),
  started_at     TIMESTAMPTZ NOT NULL,   -- first slot of the deviation
  opened_at      TIMESTAMPTZ NOT NULL,   -- slot at which it had lasted long enough to alert
  closed_at      TIMESTAMPTZ,
  last_slot_ts   TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  peak_dev_pct   NUMERIC NOT NULL,
  step           SMALLINT NOT NULL DEFAULT 1,
  reminders_sent INT NOT NULL DEFAULT 0,
  calm_slots     INT NOT NULL DEFAULT 0,
  extra_kwh      NUMERIC NOT NULL DEFAULT 0,
  acked_at       TIMESTAMPTZ,
  acked_by       UUID REFERENCES users(id),
  ack_reason     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One open episode per rule: a retried or doubled cron run cannot open a second.
CREATE UNIQUE INDEX IF NOT EXISTS uq_energy_alert_one_open_episode
  ON energy_alert_episodes (rule_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_energy_alert_episodes_location ON energy_alert_episodes (location_id, started_at DESC);

CREATE TABLE IF NOT EXISTS energy_alert_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id     UUID NOT NULL REFERENCES energy_alert_rules(id) ON DELETE CASCADE,
  episode_id  UUID REFERENCES energy_alert_episodes(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('opened', 'worse', 'reminder', 'resolved')),
  -- claimed = reserved before sending, so a second run skips it; sent = delivered;
  -- test = would have sent; held = daily cap reached; muted = rule muted; failed = send error.
  status      TEXT NOT NULL CHECK (status IN ('claimed', 'sent', 'test', 'held', 'muted', 'failed')),
  slot_ts     TIMESTAMPTZ NOT NULL,
  actual_kw   NUMERIC,
  typical_kw  NUMERIC,
  dev_pct     NUMERIC,
  extra_kwh   NUMERIC,
  subject     TEXT,
  recipients  TEXT[] NOT NULL DEFAULT '{}',
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The claim: the same decision for the same slot can only be recorded once.
  UNIQUE (rule_id, slot_ts, kind)
);

CREATE INDEX IF NOT EXISTS idx_energy_alert_events_rule ON energy_alert_events (rule_id, slot_ts DESC);
CREATE INDEX IF NOT EXISTS idx_energy_alert_events_episode ON energy_alert_events (episode_id);

ALTER TABLE energy_alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE energy_alert_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE energy_alert_events ENABLE ROW LEVEL SECURITY;

-- Reads for signed-in staff; every write goes through an API route on the service role.
DROP POLICY IF EXISTS "energy_alert_rules_select_authenticated" ON energy_alert_rules;
CREATE POLICY "energy_alert_rules_select_authenticated" ON energy_alert_rules FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "energy_alert_episodes_select_authenticated" ON energy_alert_episodes;
CREATE POLICY "energy_alert_episodes_select_authenticated" ON energy_alert_episodes FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "energy_alert_events_select_authenticated" ON energy_alert_events;
CREATE POLICY "energy_alert_events_select_authenticated" ON energy_alert_events FOR SELECT TO authenticated USING (true);

-- Global gate. dry_run means even a rule set to Live emails nobody, so merely deploying
-- this cannot reach a person (same convention as vo_renewal_cron_mode).
INSERT INTO app_settings (key, value) VALUES ('energy_alerts_cron_mode', 'dry_run')
  ON CONFLICT (key) DO NOTHING;
