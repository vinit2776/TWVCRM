-- 00285_leads_enquiry_attention.sql
-- Adds claim/resolve workflow for public-form enquiries so the dashboard
-- can distinguish "untouched", "someone is on it", and "handled".
--
-- Separation of concerns:
--   claimed_*           — soft signal that a user is responding
--   resolved_*          — terminal state with an outcome (campaign attribution)
--   attention_reset_at  — drives the overdue timer; bumped on every re-enquiry
--                         so a fresh re-submit re-opens the attention window.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS claimed_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at        timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_outcome text
    CHECK (resolution_outcome IN ('converted', 'not_interested', 'no_response')),
  ADD COLUMN IF NOT EXISTS attention_reset_at timestamptz;

-- Default attention_reset_at to created_at for existing rows.
UPDATE leads
SET    attention_reset_at = created_at
WHERE  attention_reset_at IS NULL;

ALTER TABLE leads
  ALTER COLUMN attention_reset_at SET DEFAULT now();

-- Active-queue index: only unresolved rows are queried for the dashboard widget.
CREATE INDEX IF NOT EXISTS leads_unresolved_attention_idx
  ON leads (attention_reset_at DESC)
  WHERE resolved_at IS NULL;

-- Backfill: historical form-sourced leads that already advanced past `new`
-- are treated as converted (whoever moved the status was responding).
-- Rows still at `new` stay unresolved so they show up in the active queue.
UPDATE leads
SET    resolved_at         = COALESCE(updated_at, created_at),
       resolution_outcome  = 'converted'
WHERE  tags && ARRAY['google-ads-form', 'meta-ads-form', 'walkin-form']::text[]
  AND  status <> 'new'
  AND  resolved_at IS NULL;
