-- ==========================================
-- Migration 00022: Fix app_settings RLS — add razorpay_key_id to public list
-- ==========================================
-- Problem found during smoke-test verification of migration 00018:
--
--   The /api/payments/create-order and /api/payments/create-payment-link
--   routes use createClient() (user-scoped, RLS-enforced) to fetch
--   razorpay_key_id from app_settings.  Migration 00018 only allowed
--   non-admin users to read 3 keys (razorpay_enabled, upi_id,
--   upi_qr_code_path), so razorpay_key_id was silently filtered out,
--   causing "Razorpay credentials not configured" errors for any
--   non-admin user trying to process a payment.
--
-- Fix:
--   Add razorpay_key_id (the *publishable* key — safe to expose) to the
--   public SELECT policy.  The secret keys (razorpay_key_secret,
--   razorpay_webhook_secret) remain admin-only; those are fetched
--   server-side via createAdminClient() after this migration.
-- ==========================================

-- Drop the existing public policy (needs to be recreated with extra key).
DROP POLICY IF EXISTS "Public settings readable by authenticated users" ON public.app_settings;

-- Recreate with razorpay_key_id included.
CREATE POLICY "Public settings readable by authenticated users"
  ON public.app_settings FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND key IN (
      'razorpay_enabled',
      'razorpay_key_id',
      'upi_id',
      'upi_qr_code_path'
    )
  );
