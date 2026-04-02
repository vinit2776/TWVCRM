-- Create the crm-documents storage bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'crm-documents',
  'crm-documents',
  false,
  10485760,
  ARRAY[
    'application/pdf',
    'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- RLS: authenticated users can upload to crm-documents
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Authenticated can upload crm documents'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can upload crm documents"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'crm-documents')
    $policy$;
  END IF;
END $$;

-- RLS: authenticated users can read crm-documents
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Authenticated can view crm documents'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can view crm documents"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'crm-documents')
    $policy$;
  END IF;
END $$;

-- RLS: authenticated users can update their uploads in crm-documents
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Authenticated can update crm documents'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Authenticated can update crm documents"
      ON storage.objects FOR UPDATE
      TO authenticated
      USING (bucket_id = 'crm-documents')
    $policy$;
  END IF;
END $$;
