-- idx_usage_charges_contract_status_date (00237 #1) exists on prod but is INVALID
-- (pg_index.indisvalid = false): its original CREATE INDEX CONCURRENTLY build was
-- interrupted, leaving a half-built index the query planner ignores while writes
-- still maintain it. Drop and rebuild it cleanly. usage_charges is tiny (19 rows),
-- so a plain rebuild is instant and the brief lock is negligible.

DROP INDEX IF EXISTS idx_usage_charges_contract_status_date;

CREATE INDEX IF NOT EXISTS idx_usage_charges_contract_status_date
  ON usage_charges (contract_id, status, charge_date DESC)
  WHERE status = 'pending';
