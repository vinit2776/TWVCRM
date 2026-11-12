-- ============================================================
-- Migration 00531: Vendor bill supporting documents
-- ============================================================
-- A vendor bill previously held exactly one file (invoice_file_url,
-- set once at creation). This adds a running list of documents per
-- bill so additional paperwork (a debit note, delivery proof, a
-- corrected invoice) can be attached at any time — including after
-- approval.
--
-- Editing or deleting an existing document is only allowed while the
-- bill is still pending or rejected. Once a bill is approved, Vinit
-- has approved payment against those exact files, so they must not
-- change or disappear — new documents can still be added on top.
-- That lock is enforced here at the RLS level (not just in the API
-- route) so it can't be bypassed by a direct table write.

CREATE TABLE IF NOT EXISTS vendor_bill_documents (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id     UUID        NOT NULL REFERENCES vendor_bills(id) ON DELETE CASCADE,
  file_url    TEXT        NOT NULL,
  file_name   TEXT        NOT NULL,
  doc_type    TEXT        NOT NULL DEFAULT 'supporting' CHECK (doc_type IN ('invoice', 'supporting')),
  uploaded_by UUID        NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_bill_documents_bill_id
  ON vendor_bill_documents(bill_id);

ALTER TABLE vendor_bill_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read bill documents"
  ON vendor_bill_documents FOR SELECT
  TO authenticated USING (true);

-- Adding a document is always allowed, regardless of approval state —
-- who specifically may act on a given bill is gated in the API route,
-- same as the rest of the vendor-bill endpoints.
CREATE POLICY "Authenticated users can insert bill documents"
  ON vendor_bill_documents FOR INSERT
  TO authenticated WITH CHECK (true);

-- Edit/delete only while the parent bill has not been approved yet.
CREATE POLICY "Bill documents editable before approval"
  ON vendor_bill_documents FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM vendor_bills vb
      WHERE vb.id = vendor_bill_documents.bill_id
        AND vb.approval_status != 'approved'
    )
  );

CREATE POLICY "Bill documents deletable before approval"
  ON vendor_bill_documents FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM vendor_bills vb
      WHERE vb.id = vendor_bill_documents.bill_id
        AND vb.approval_status != 'approved'
    )
  );

-- Backfill: every existing bill's invoice_file_url becomes its first document.
INSERT INTO vendor_bill_documents (bill_id, file_url, file_name, doc_type, uploaded_by, created_at)
SELECT
  id,
  invoice_file_url,
  COALESCE(NULLIF(split_part(invoice_file_url, '/', -1), ''), 'invoice'),
  'invoice',
  created_by,
  created_at
FROM vendor_bills
WHERE invoice_file_url IS NOT NULL;
