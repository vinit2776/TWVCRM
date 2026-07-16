-- Persisted line-by-line breakdown of how kpi_points was computed
-- (base + bonuses - penalties), so the score can be explained on the
-- ticket detail page rather than just displayed as a bare number.
-- Stored at the same time as kpi_points so it always matches what was
-- actually scored, even if the ticket's fields (e.g. reopen_count)
-- change afterward.

ALTER TABLE facility_issues ADD COLUMN IF NOT EXISTS kpi_breakdown JSONB;
