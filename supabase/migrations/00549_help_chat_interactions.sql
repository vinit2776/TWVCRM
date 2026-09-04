-- Structured, PII-free usage analytics for the WorkVilla Assistant help
-- chat — never the question or answer text (see 00548's comment: a
-- free-text question can carry customer PII, and CLAUDE.md prohibits
-- logging that even at debug level). Only enough structure to answer
-- "where is it used" and "is it helping": which page, which role, whether
-- any knowledgebase section matched (and which), plus an optional thumbs
-- up/down the user can set afterward.

CREATE TABLE IF NOT EXISTS help_chat_interactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  page_path   TEXT NOT NULL,
  had_match   BOOLEAN NOT NULL,
  section_ids TEXT[] NOT NULL DEFAULT '{}',
  feedback    TEXT CHECK (feedback IN ('helpful', 'not_helpful')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE help_chat_interactions ENABLE ROW LEVEL SECURITY;

-- The chat route inserts one row per answered question, under the asking
-- user's own session (never the admin client) — so insert is scoped to
-- "your own user_id" via the same auth_id lookup used throughout the app.
CREATE POLICY "Users can insert their own help_chat_interactions"
  ON help_chat_interactions FOR INSERT
  WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- Feedback (thumbs up/down) is set afterward via an UPDATE on the same row.
CREATE POLICY "Users can update their own help_chat_interactions"
  ON help_chat_interactions FOR UPDATE
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- Usage analytics are admin-only, same as the Assistant Analytics page.
CREATE POLICY "Admins can read all help_chat_interactions"
  ON help_chat_interactions FOR SELECT
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = 'admin'));

CREATE INDEX IF NOT EXISTS idx_help_chat_interactions_created_at
  ON help_chat_interactions (created_at DESC);
