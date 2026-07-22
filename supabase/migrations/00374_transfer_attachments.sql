-- ============================================================
-- Migration 00374: Transfer photo attachments
-- ------------------------------------------------------------
-- Lets the receiver document item state/damage with photos at receive
-- time, to support any complaints raised afterward. Mirrors the existing
-- facility_issue_attachments + facility-issue-photos pattern (00116).
--
-- Rollback: drop stock_transfer_attachments, the storage policies, and
-- the stock-transfer-photos bucket row.
-- ============================================================

CREATE TABLE IF NOT EXISTS stock_transfer_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id   UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  issue_id      UUID REFERENCES stock_transfer_issues(id) ON DELETE CASCADE,
  file_url      TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  file_type     VARCHAR(20) NOT NULL DEFAULT 'image',
  caption       TEXT,
  uploaded_by   UUID REFERENCES users(id),
  uploaded_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfer_attach_transfer ON stock_transfer_attachments(transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_attach_issue    ON stock_transfer_attachments(issue_id);

ALTER TABLE stock_transfer_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "transfer_attach_select" ON stock_transfer_attachments;
DROP POLICY IF EXISTS "transfer_attach_write"  ON stock_transfer_attachments;

CREATE POLICY "transfer_attach_select" ON stock_transfer_attachments
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "transfer_attach_write" ON stock_transfer_attachments
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Storage bucket: stock-transfer-photos (private)
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'stock-transfer-photos',
  'stock-transfer-photos',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated can upload transfer photos'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can upload transfer photos"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'stock-transfer-photos')
    $policy$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated can view transfer photos'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can view transfer photos"
      ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'stock-transfer-photos')
    $policy$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated can delete transfer photos'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can delete transfer photos"
      ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'stock-transfer-photos')
    $policy$;
  END IF;
END $$;
