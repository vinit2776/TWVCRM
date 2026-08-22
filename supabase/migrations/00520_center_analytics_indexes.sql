-- Center Analytics reads contracts.activated_at to bucket "sales" (new
-- business booked) into the selected date range. No existing index covers
-- it — see docs/plans/center-analytics-data-source.md. Partial: activated_at
-- is NULL for every draft contract, so there's no point indexing those rows.
CREATE INDEX IF NOT EXISTS idx_contracts_activated_at
  ON contracts (activated_at)
  WHERE activated_at IS NOT NULL;
