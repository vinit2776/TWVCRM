-- Per-person "last opened" marker on each query thread, so the inbox can flag
-- replies that arrived since you last looked ("New reply").
--
-- Writes go through the service role in /api/queries/[id] (GET marks read), so
-- there is deliberately no INSERT/UPDATE policy: a client can't forge or wipe
-- another person's read state. Readers only ever see their own rows.

CREATE TABLE IF NOT EXISTS query_reads (
  query_id     UUID NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (query_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_query_reads_user ON query_reads (user_id);

ALTER TABLE query_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own query_reads" ON query_reads;
CREATE POLICY "Users can read their own query_reads"
  ON query_reads FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Only replies after this moment can show as "new". Without it every existing
-- thread would light up for everyone the day this ships. Missing or
-- unparseable means nothing shows as new (the quiet direction).
INSERT INTO app_settings (key, value)
VALUES ('queries_unread_effective_from', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO NOTHING;

-- Rollback:
--   DROP TABLE IF EXISTS query_reads;
--   DELETE FROM app_settings WHERE key = 'queries_unread_effective_from';
