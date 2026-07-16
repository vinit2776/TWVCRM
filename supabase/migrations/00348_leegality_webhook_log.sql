-- Migration: leegality_webhook_log
-- Purpose: Log every inbound Leegality webhook call (including signature failures
-- and unmatched document IDs). Without this, the only trace of a webhook firing
-- was a console.log line — there was no way to confirm after the fact whether
-- Leegality ever called back, or why a signing status update didn't land.

CREATE TABLE IF NOT EXISTS leegality_webhook_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      text,                                        -- Leegality document ID (may be null if payload malformed)
  status            text,                                        -- normalized status parsed from payload
  signature_valid  boolean     NOT NULL,
  outcome          text        NOT NULL DEFAULT 'received',      -- received | processed | ignored | error
  outcome_detail   text,                                         -- human-readable note (e.g. "no matching contract/agreement")
  raw_payload      jsonb,
  received_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leegality_webhook_log_document_id  ON leegality_webhook_log (document_id);
CREATE INDEX IF NOT EXISTS idx_leegality_webhook_log_received_at  ON leegality_webhook_log (received_at DESC);

ALTER TABLE leegality_webhook_log ENABLE ROW LEVEL SECURITY;

-- Only admins can read the webhook log (service role writes it)
CREATE POLICY "admins can view leegality webhook log"
  ON leegality_webhook_log FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = 'admin'
    )
  );
