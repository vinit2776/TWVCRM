-- Lock two payment functions to the server.
--
-- record_billing_payment_guarded (00603) and close_payment_report (00644) were
-- created with REVOKE ALL ... FROM PUBLIC and GRANT EXECUTE ... TO service_role.
-- Supabase also grants EXECUTE on new public functions to anon and
-- authenticated through default privileges, and revoking from PUBLIC does not
-- remove those explicit grants, so a browser session could still call them
-- through PostgREST. Both are only ever called from API routes with the
-- service-role client, so nothing depends on those grants. This matches the
-- REVOKE ... FROM PUBLIC, anon, authenticated used for create_usage_invoice
-- (00564) and the pooled-deposit functions (00576, 00581).
--
-- Rollback:
--   GRANT EXECUTE ON FUNCTION close_payment_report(UUID, UUID, UUID) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION record_billing_payment_guarded(UUID, NUMERIC, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, UUID) TO anon, authenticated;

REVOKE ALL ON FUNCTION close_payment_report(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION record_billing_payment_guarded(UUID, NUMERIC, DATE, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, UUID) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
