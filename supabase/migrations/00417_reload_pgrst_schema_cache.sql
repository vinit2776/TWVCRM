-- Force PostgREST to reload its schema cache so the new billing_queries /
-- billing_query_messages tables and their FK relationships are queryable
-- immediately, without waiting for the periodic auto-reload. Same fix as
-- 00413_reload_pgrst_schema_cache.sql, needed again for these new tables.
NOTIFY pgrst, 'reload schema';
