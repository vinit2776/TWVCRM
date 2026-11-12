-- Manual credit-note cancellation for Tally-issued invoices.
--
-- Replaces the dead automated-bridge cancel path (POST .../cancel-tally,
-- enqueueTallyCreditNote in src/lib/tally/enqueue.ts — shelved, gated on
-- tally_sync_enabled which is false in production) with a manual upload flow
-- mirroring gst_invoice_uploads: the accountant creates the credit note in
-- Tally themselves and uploads the resulting number/date/amount/PDF back.
--
-- billing_statements.tally_credit_note_number / tally_credit_note_guid
-- already exist (migration 00242) and billing_statements_lifecycle_stage_check
-- already allows 'cancelled' (same migration) — no changes needed there.

CREATE TABLE credit_note_uploads (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_statement_id      uuid NOT NULL REFERENCES billing_statements(id) ON DELETE RESTRICT,
  uploaded_by               uuid NOT NULL REFERENCES auth.users(id),
  uploaded_at               timestamptz NOT NULL DEFAULT now(),

  -- Snapshot of the invoice being reversed, at cancel time.
  original_invoice_number   text NOT NULL,
  original_invoice_series   text NOT NULL
                            CHECK (original_invoice_series IN ('SDIPL-REG', 'SDIPL-UNREG')),

  -- The credit note itself.
  credit_note_number        text NOT NULL,
  credit_note_series        text NOT NULL
                            CHECK (credit_note_series IN ('CREDIT NOTE-REG', 'CREDIT NOTE-UNREG')),
  credit_note_date          date NOT NULL,
  credit_note_amount        numeric(12, 2) NOT NULL,
  credit_note_pdf_url       text NOT NULL,
  reason                    text NOT NULL,

  -- Audit chain (re-uploads supersede earlier uploads, mirrors gst_invoice_uploads).
  superseded_by             uuid REFERENCES credit_note_uploads(id),
  notes                     text,

  CONSTRAINT credit_note_uploads_series_matches_original CHECK (
    (original_invoice_series = 'SDIPL-REG'   AND credit_note_series = 'CREDIT NOTE-REG') OR
    (original_invoice_series = 'SDIPL-UNREG' AND credit_note_series = 'CREDIT NOTE-UNREG')
  ),

  CONSTRAINT credit_note_uploads_amount_positive CHECK (credit_note_amount > 0)
);

CREATE INDEX idx_credit_note_uploads_statement ON credit_note_uploads (billing_statement_id);
CREATE INDEX idx_credit_note_uploads_number ON credit_note_uploads (credit_note_number);
CREATE INDEX idx_credit_note_uploads_uploaded_at ON credit_note_uploads (uploaded_at DESC);

ALTER TABLE credit_note_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "credit_note_uploads_select_accounts_admin"
  ON credit_note_uploads
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role IN ('accounts', 'admin', 'office_admin', 'manager')
    )
  );

CREATE POLICY "credit_note_uploads_insert_accounts_admin"
  ON credit_note_uploads
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role IN ('accounts', 'admin')
    )
  );

-- No UPDATE/DELETE policy — uploads are audit records, correct via superseded_by.

COMMENT ON TABLE credit_note_uploads IS
  'One row per accountant upload of a manually-created Tally credit note, cancelling a Tally-issued GST invoice. See POST /api/billing-statements/[id]/upload-credit-note.';
