-- Migration 00739: optional bills / proof of payment on petty cash
-- One row per uploaded file, attached to either an expense (receipt) or a fund
-- request (payment proof at issue). Files live in the private crm-documents bucket;
-- only the storage PATH is kept (signed URLs are minted on read).
-- Writes go through API routes with the service role, so RLS only grants SELECT.
-- Rollback: DROP TABLE petty_cash_attachments; DELETE FROM app_settings WHERE key = 'petty_cash_receipt_nudge_amount';

CREATE TABLE IF NOT EXISTS petty_cash_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id      UUID REFERENCES petty_cash_entries(id) ON DELETE CASCADE,
  request_id    UUID REFERENCES petty_cash_requests(id) ON DELETE CASCADE,
  kind          VARCHAR(20) NOT NULL DEFAULT 'receipt' CHECK (kind IN ('receipt', 'payment_proof', 'other')),
  storage_path  TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  mime_type     VARCHAR(100) NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0),
  uploaded_by   UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_pc_attachment_target CHECK (
    (entry_id IS NOT NULL AND request_id IS NULL) OR
    (entry_id IS NULL AND request_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pc_attachments_entry   ON petty_cash_attachments(entry_id);
CREATE INDEX IF NOT EXISTS idx_pc_attachments_request ON petty_cash_attachments(request_id);

ALTER TABLE petty_cash_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read petty_cash_attachments"
  ON petty_cash_attachments FOR SELECT TO authenticated USING (true);

GRANT SELECT ON petty_cash_attachments TO authenticated;
GRANT ALL ON petty_cash_attachments TO service_role;

-- Expenses at or above this amount with no bill attached get an amber "no receipt" nudge.
INSERT INTO app_settings (key, value)
VALUES ('petty_cash_receipt_nudge_amount', '1000')
ON CONFLICT (key) DO NOTHING;
