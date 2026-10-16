-- ============================================================
-- Migration 00599: "Withdrawn" vendor bills (admin rollback of bill creation)
--
-- A bill uploaded against the wrong PO, or twice, had no way out: bills cannot
-- be deleted, and a pending/rejected bill still counted against the PO and
-- blocked cancelling it. Withdrawing marks the bill withdrawn — it stays in
-- history but is ignored by every queue, total and duplicate check — and puts
-- the goods PO back to the status it had before the bill arrived.
-- ============================================================

ALTER TABLE vendor_bills DROP CONSTRAINT IF EXISTS vendor_bills_approval_status_check;
ALTER TABLE vendor_bills ADD CONSTRAINT vendor_bills_approval_status_check
  CHECK (approval_status IN ('pending', 'approved', 'rejected', 'withdrawn'));

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS withdrawn_at          TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS withdrawn_by          UUID        REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS withdrawn_reason      TEXT        DEFAULT NULL,
  -- The goods PO's status just before this bill moved it to invoice_received.
  -- NULL on older bills (the app then derives it from received quantities).
  ADD COLUMN IF NOT EXISTS po_status_before_bill TEXT        DEFAULT NULL;

-- A withdrawn bill is as locked as an approved one: no document edits.
DROP POLICY IF EXISTS "Bill documents editable before approval" ON vendor_bill_documents;
CREATE POLICY "Bill documents editable before approval"
  ON vendor_bill_documents FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM vendor_bills vb
      WHERE vb.id = vendor_bill_documents.bill_id
        AND vb.approval_status NOT IN ('approved', 'withdrawn')
    )
  );

DROP POLICY IF EXISTS "Bill documents deletable before approval" ON vendor_bill_documents;
CREATE POLICY "Bill documents deletable before approval"
  ON vendor_bill_documents FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM vendor_bills vb
      WHERE vb.id = vendor_bill_documents.bill_id
        AND vb.approval_status NOT IN ('approved', 'withdrawn')
    )
  );
