-- Index for user-wise audit trail queries
-- Enables fast filtering of audit_trail by performed_by (user ID)
--
-- CONCURRENTLY removed: Supabase's migration runner pipelines statements and
-- CONCURRENTLY cannot run inside a pipeline (same issue documented in
-- 00149/00237/00239/00256). audit_trail's write pattern is append-only inserts,
-- so a brief lock during index build is fine.
CREATE INDEX IF NOT EXISTS idx_audit_performed_by
  ON audit_trail(performed_by, created_at DESC);
