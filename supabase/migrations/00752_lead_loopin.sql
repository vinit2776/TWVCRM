-- Keep informed: someone who owns a lead can ask a colleague to see it in their work without giving
-- them a job. Each row says who, why (required), who asked, and when it clears itself (14 days).
-- The colleague answers "Got it" or "Not for me"; either takes it off their list. Written only by
-- the routes (service role). Also seeds the switch `lead_loopin_enabled` (off).
-- Rollback:
--   DROP TABLE IF EXISTS lead_watchers; DELETE FROM app_settings WHERE key = 'lead_loopin_enabled';

CREATE TABLE IF NOT EXISTS lead_watchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  answer text CHECK (answer IN ('got_it', 'not_for_me')),
  answered_at timestamptz,
  UNIQUE (lead_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_watchers_user ON lead_watchers (user_id, expires_at) WHERE answer IS NULL;

ALTER TABLE lead_watchers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lead_watchers_select" ON lead_watchers;
CREATE POLICY "lead_watchers_select" ON lead_watchers FOR SELECT TO authenticated USING (true);

INSERT INTO app_settings (key, value)
VALUES ('lead_loopin_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
