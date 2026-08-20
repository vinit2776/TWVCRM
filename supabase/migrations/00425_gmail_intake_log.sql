-- Gmail inbound intake — Phase 1 (shadow mode)
--
-- The inbound pipeline (/api/email/inbound) has never run in production: no
-- GMAIL_* env vars have ever been set, app_settings has no gmail_history_id,
-- and case_emails is empty. Before it is allowed to auto-create cases against
-- the live Cases module, it runs in shadow mode: every message is evaluated
-- and recorded here, but no case, document checklist or compliance row is
-- written.
--
-- case_emails cannot serve this purpose — its case_id is NOT NULL, so there is
-- nowhere to record a message that deliberately did not create a case.

CREATE TABLE IF NOT EXISTS gmail_intake_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  gmail_message_id      VARCHAR(255) NOT NULL,
  gmail_thread_id       VARCHAR(255),
  from_email            VARCHAR(255),
  subject               VARCHAR(500),

  matched_aggregator_id UUID REFERENCES aggregators(id) ON DELETE SET NULL,

  -- Full AI extraction. Same shape that would have been written to cases, kept
  -- so parse quality can be judged against real mail before anything is
  -- created. Holds client PII, hence the admin-only SELECT policy below.
  parsed                JSONB,
  ai_confidence         NUMERIC,
  needs_manual_review   BOOLEAN,

  -- What the pipeline did, or would have done had auto-creation been enabled:
  -- 'would_create_case' | 'would_append_to_thread' | 'skipped_no_aggregator'
  -- | 'skipped_incomplete' | 'parse_failed' | 'created_case'
  action                TEXT NOT NULL,

  -- TRUE while auto-creation is off, so shadow rows are never mistaken for
  -- rows describing real writes.
  dry_run               BOOLEAN NOT NULL DEFAULT TRUE,
  error                 TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pub/Sub delivers at-least-once and retries on any non-2xx, so the same
-- message id will arrive again. This is what makes reprocessing idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gmail_intake_log_message
  ON gmail_intake_log (gmail_message_id);

CREATE INDEX IF NOT EXISTS idx_gmail_intake_log_created
  ON gmail_intake_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gmail_intake_log_action
  ON gmail_intake_log (action, created_at DESC);

ALTER TABLE gmail_intake_log ENABLE ROW LEVEL SECURITY;

-- Admin only: rows carry AI-extracted client PII (name, PAN, GST, phone,
-- address). Writes come from the webhook via the service-role client, which
-- bypasses RLS, so no INSERT policy is needed.
CREATE POLICY "Admins can read gmail_intake_log"
  ON gmail_intake_log FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role = 'admin'
        AND is_active = true
    )
  );

-- Auto-creation stays off until shadow-mode output has been reviewed. Phase 3
-- flips this; nothing in Phase 1 turns it on.
INSERT INTO app_settings (key, value)
VALUES ('gmail_auto_case_creation_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
