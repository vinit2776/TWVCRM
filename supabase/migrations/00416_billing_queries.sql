-- Accounts-to-management query threads on billing statements.
--
-- Accounts raises a question tied to a specific statement (e.g. "what does
-- this line item mean, which ledger do I book it to") from the Tally Inbox;
-- admin/manager/sales_rep see and answer it from the standalone
-- /billing-queries page — independent of Tally Inbox access, which
-- sales_rep does not have (see INBOX_ROLES in src/lib/tally-handoff.ts).
--
-- billing_queries = the thread itself (one row per question, carries the
-- open/resolved lifecycle). billing_query_messages = every message in the
-- thread, including the opening question (event_type = 'message') and
-- status-change markers (event_type = 'resolved' / 'reopened') — mirrors
-- facility_issue_events' typed-timeline pattern so a resolution note shows
-- up inline with the replies instead of as a separate, disconnected field.

CREATE TABLE billing_queries (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_statement_id  UUID NOT NULL REFERENCES billing_statements(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_by            UUID NOT NULL REFERENCES users(id),
  resolved_by           UUID REFERENCES users(id),
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_billing_queries_statement ON billing_queries(billing_statement_id);
CREATE INDEX idx_billing_queries_status ON billing_queries(status);
CREATE INDEX idx_billing_queries_updated ON billing_queries(updated_at DESC);

CREATE TRIGGER update_billing_queries_updated_at BEFORE UPDATE ON billing_queries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE billing_query_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id    UUID NOT NULL REFERENCES billing_queries(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL DEFAULT 'message' CHECK (event_type IN ('message', 'resolved', 'reopened')),
  body        TEXT,
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_query_messages_body_required CHECK (
    event_type <> 'message' OR (body IS NOT NULL AND length(trim(body)) > 0)
  )
);

CREATE INDEX idx_billing_query_messages_query ON billing_query_messages(query_id, created_at);

ALTER TABLE billing_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_query_messages ENABLE ROW LEVEL SECURITY;

-- Role gating (who can create/reply/resolve) is enforced at the app layer
-- via BILLING_QUERY_ROLES (src/lib/billing-queries.ts), matching the
-- convention already used for reimbursement_supporting_documents (00408)
-- and credit_note_uploads (00406) rather than embedding role checks in RLS.
CREATE POLICY "Authenticated users can read billing_queries"
  ON billing_queries FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert billing_queries"
  ON billing_queries FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update billing_queries"
  ON billing_queries FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can read billing_query_messages"
  ON billing_query_messages FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert billing_query_messages"
  ON billing_query_messages FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- No UPDATE/DELETE policy on messages — append-only, same as
-- gst_invoice_uploads / credit_note_uploads.

COMMENT ON TABLE billing_queries IS
  'One row per accounts question raised on a billing statement, answered by admin/manager/sales_rep from /billing-queries. See src/lib/billing-queries.ts.';
COMMENT ON TABLE billing_query_messages IS
  'Every message in a billing_queries thread, including the opening question and resolved/reopened status markers.';
