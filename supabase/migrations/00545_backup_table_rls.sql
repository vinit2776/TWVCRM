-- Two rollback-snapshot tables were left without RLS after their migrations
-- ran, so they were publicly readable/writable via PostgREST to anyone with
-- the project's anon key (Supabase security advisor: rls_disabled_in_public,
-- ERROR level). Both hold a copy of real customer data:
--   cases_source_backup_00531               -- case/aggregator snapshot (00531)
--   contract_documents_deferral_backup_00538 -- deferral snapshot (00538)
--
-- Neither table is read by the app — they exist only so a specific
-- production row could be rolled back by hand via SQL if the conversion in
-- 00531/00538 turned out to be wrong. No policy is defined, so RLS denies
-- all access through the API; the service role (and direct DB access, for
-- an actual rollback) still bypasses RLS as usual.
ALTER TABLE cases_source_backup_00531 ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_documents_deferral_backup_00538 ENABLE ROW LEVEL SECURITY;
