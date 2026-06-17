-- Add tally_handoff_v2_enabled to the public-readable app_settings keys so
-- server routes using createClient() (user-scoped RLS) can read the flag.
DROP POLICY IF EXISTS "Public settings readable by authenticated users" ON public.app_settings;

CREATE POLICY "Public settings readable by authenticated users"
  ON public.app_settings FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND key IN (
      'razorpay_enabled',
      'razorpay_key_id',
      'upi_id',
      'upi_qr_code_path',
      'tally_handoff_v2_enabled'
    )
  );
