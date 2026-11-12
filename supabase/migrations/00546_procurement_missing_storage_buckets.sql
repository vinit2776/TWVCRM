-- Fix: "delivery-challans" and "service-reports" storage buckets were
-- referenced by the procurement PO detail page (uploadFile() in
-- src/app/(dashboard)/procurement/orders/[id]/page.tsx) but were never
-- created via migration, and had no RLS policy on storage.objects. Every
-- upload attempt against either bucket failed with "new row violates
-- row-level security policy". Mirrors the vendor-invoices bucket (00026).

-- delivery-challans
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'delivery-challans',
  'delivery-challans',
  true,
  10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated can upload delivery challans'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can upload delivery challans"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'delivery-challans')
    $policy$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated can view delivery challans'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can view delivery challans"
      ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'delivery-challans')
    $policy$;
  END IF;
END $$;

-- service-reports
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'service-reports',
  'service-reports',
  true,
  10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated can upload service reports'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can upload service reports"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'service-reports')
    $policy$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Authenticated can view service reports'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can view service reports"
      ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'service-reports')
    $policy$;
  END IF;
END $$;
