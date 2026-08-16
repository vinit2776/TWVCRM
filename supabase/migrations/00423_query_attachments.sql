-- Attachments on query messages.
--
-- "Which payment is this?" is much easier to answer with the bank statement
-- screenshot attached than described in prose, so a message can carry files.
-- One message can have several; deleting the message (or its thread) takes
-- them with it.
--
-- Files live in the `crm-documents` Supabase Storage bucket under
-- queries/<query_id>/, and are served through
-- GET /api/queries/attachments/[id], which re-checks that the viewer's role
-- is authorized on the thread's entity type before handing back a short-lived
-- signed URL. `file_path` is a storage key, never a public URL — same as
-- reimbursement_supporting_documents (00408), whose shape this follows.

CREATE TABLE query_attachments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     UUID NOT NULL REFERENCES query_messages(id) ON DELETE CASCADE,
  file_path      TEXT NOT NULL,
  file_name      VARCHAR(255) NOT NULL,
  file_mime_type VARCHAR(100) NOT NULL,
  size_bytes     INTEGER,
  uploaded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_query_attachments_message ON query_attachments (message_id);

ALTER TABLE query_attachments ENABLE ROW LEVEL SECURITY;

-- Role gating lives in the app layer (src/lib/queries/registry.ts), matching
-- the convention used by queries/query_messages (00421) and
-- reimbursement_supporting_documents (00408).
CREATE POLICY "Authenticated users can read query_attachments"
  ON query_attachments FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert query_attachments"
  ON query_attachments FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- No UPDATE/DELETE policy — append-only, like query_messages. Attachments go
-- away with their message via the cascade, not by being edited out from
-- under a conversation someone has already read.

COMMENT ON TABLE query_attachments IS
  'Files attached to a query message. Served via /api/queries/attachments/[id], which re-checks entity-type authorization; file_path is a crm-documents storage key, not a public URL.';

NOTIFY pgrst, 'reload schema';
