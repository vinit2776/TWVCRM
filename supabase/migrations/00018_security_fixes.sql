-- ==========================================
-- Migration 00018: Security Fixes
-- ==========================================
-- Fixes two Supabase Security Advisor errors:
--
-- ERROR 1 — function_search_path_mutable
--   handle_new_user() is SECURITY DEFINER but does not set a
--   fixed search_path. An attacker who can CREATE SCHEMA could
--   shadow public.users and intercept new-user inserts.
--   Fix: re-define with SET search_path = '' and fully-qualified
--   object names.  Also harden all other trigger/helper functions
--   with SET search_path = public (best-practice).
--
-- ERROR 2 — app_settings exposes sensitive Razorpay secrets
--   The existing SELECT policy allows every authenticated user
--   (including sales_rep / floor_manager) to read ALL settings,
--   including razorpay_key_secret and razorpay_webhook_secret.
--   Fix: drop the permissive read policy and replace with:
--     • a restricted policy that lets any authenticated user read
--       only the non-sensitive public settings (razorpay_enabled,
--       upi_id, upi_qr_code_path), AND
--     • an admin-only policy for sensitive keys, enforced by
--       checking the role column in public.users.
-- ==========================================


-- ==========================================
-- FIX 1a: handle_new_user — SECURITY DEFINER + fixed search_path
-- ==========================================
-- Uses fully-qualified names (public.users) so the function is
-- immune to search_path injection regardless of calling context.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (auth_id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';


-- ==========================================
-- FIX 1b: Harden all other trigger/helper functions
-- (none of these are SECURITY DEFINER, but fixing search_path is
-- still best practice and passes the Supabase lint checks)
-- ==========================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION update_lead_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.first_name, '') || ' ' ||
    COALESCE(NEW.last_name, '') || ' ' ||
    COALESCE(NEW.email, '') || ' ' ||
    COALESCE(NEW.phone, '') || ' ' ||
    COALESCE(NEW.company, '') || ' ' ||
    COALESCE(array_to_string(NEW.tags, ' '), '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION generate_proposal_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(proposal_number FROM 'TWV-P-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM public.proposals;
  NEW.proposal_number := 'TWV-P-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(invoice_number FROM 'TWV-PI-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM public.proforma_invoices;
  NEW.invoice_number := 'TWV-PI-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION generate_contract_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(contract_number FROM 'TWV-C-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM public.contracts;
  NEW.contract_number := 'TWV-C-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION generate_statement_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(statement_number FROM 'TWV-BS-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM public.billing_statements;
  NEW.statement_number := 'TWV-BS-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION generate_booking_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(booking_number FROM 'TWV-B-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM public.bookings;
  NEW.booking_number := 'TWV-B-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION generate_contract_payment_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(payment_number FROM 'TWV-CP-(\d+)') AS INTEGER)
  ), 0) + 1 INTO next_num FROM public.contract_payments;
  NEW.payment_number := 'TWV-CP-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION generate_aggregator_code()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 'TWV-AGG-(\d+)') AS INTEGER)), 0) + 1
    INTO next_num FROM public.aggregators;
  NEW.code := 'TWV-AGG-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION generate_case_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(case_number FROM 'TWV-CASE-(\d+)') AS INTEGER)), 0) + 1
    INTO next_num FROM public.cases;
  NEW.case_number := 'TWV-CASE-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION generate_agreement_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(agreement_number FROM 'TWV-AGR-(\d+)') AS INTEGER)), 0) + 1
    INTO next_num FROM public.case_agreements;
  NEW.agreement_number := 'TWV-AGR-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION generate_agg_invoice_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 'TWV-AI-(\d+)') AS INTEGER)), 0) + 1
    INTO next_num FROM public.aggregator_invoices;
  NEW.invoice_number := 'TWV-AI-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION recalculate_lead_score()
RETURNS TRIGGER AS $$
DECLARE
  avg_rating NUMERIC;
BEGIN
  IF NEW.lead_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT AVG(overall_rating) INTO avg_rating
  FROM public.booking_feedbacks
  WHERE lead_id = NEW.lead_id AND overall_rating IS NOT NULL;

  IF avg_rating IS NOT NULL THEN
    UPDATE public.leads
    SET score = LEAST(100, GREATEST(0, ROUND((avg_rating - 1) * 25)))
    WHERE id = NEW.lead_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;


-- ==========================================
-- FIX 2: app_settings — restrict sensitive keys to admin only
-- ==========================================
-- Drop the current permissive read policy that exposes all
-- settings (including Razorpay secrets) to every logged-in user.
DROP POLICY IF EXISTS "Authenticated users can read settings" ON public.app_settings;

-- Policy A: any authenticated user may read the non-sensitive public settings
-- (razorpay_enabled, upi_id, upi_qr_code_path).
-- Sensitive keys (razorpay_key_id, razorpay_key_secret,
-- razorpay_webhook_secret) are excluded via the key filter.
CREATE POLICY "Public settings readable by authenticated users"
  ON public.app_settings FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND key IN ('razorpay_enabled', 'upi_id', 'upi_qr_code_path')
  );

-- Policy B: admin users can read ALL settings (including secret keys).
-- Role is looked up in public.users — the search is efficient via the
-- existing idx_users_auth_id index.
CREATE POLICY "Admin can read all settings"
  ON public.app_settings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role = 'admin'
        AND is_active = true
    )
  );

-- INSERT / UPDATE already restricted by existing policies; no changes needed.
-- (They already require auth.uid() IS NOT NULL — the app uses the service-role
--  key for server-side writes, which bypasses RLS entirely and is correct.)
