-- Sprint 3.8: Vendor Invoice upload + invoice_received PO status

-- 1. Add invoice_received value to po_status enum
ALTER TYPE po_status ADD VALUE IF NOT EXISTS 'invoice_received';

-- 2. Add invoice_file_url to vendor_bills
ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS invoice_file_url TEXT;

-- 3. Create vendor-invoices storage bucket (public so permanent URLs work)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'vendor-invoices',
  'vendor-invoices',
  true,
  10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- 4. RLS: authenticated users can upload to vendor-invoices
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Authenticated can upload vendor invoices'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can upload vendor invoices"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'vendor-invoices')
    $policy$;
  END IF;
END $$;

-- 5. RLS: authenticated users can view vendor-invoices objects
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Authenticated can view vendor invoices'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can view vendor invoices"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'vendor-invoices')
    $policy$;
  END IF;
END $$;
