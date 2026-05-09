-- Index for user-wise audit trail queries
-- Enables fast filtering of audit_trail by performed_by (user ID)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_performed_by
  ON audit_trail(performed_by, created_at DESC);
