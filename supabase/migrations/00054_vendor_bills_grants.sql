-- ==========================================
-- Migration 00054: Vendor Bills Explicit GRANTs
-- ==========================================
-- Ensures the authenticated role has explicit table-level permissions on
-- vendor_bills. The existing RLS policies in 00019 lack the explicit GRANT
-- statements that Supabase requires for the approval workflow columns
-- added in 00052 (approval_status, approved_by, approved_at, etc.).
-- Follows the same pattern as 00053 (support_tickets fix).
-- ==========================================

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_bills TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_bills TO service_role;

-- Also ensure po_service_reports (new table from service PO feature) has grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.po_service_reports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.po_service_reports TO service_role;
