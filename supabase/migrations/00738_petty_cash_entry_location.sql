-- Migration 00738: location on petty cash expenses
-- Lets management see petty cash spend by centre. Nullable: older expenses
-- are backfilled from the submitter's single primary location where there is
-- exactly one; anything ambiguous stays NULL and shows as "No location".
-- Rollback: ALTER TABLE petty_cash_entries DROP COLUMN location_id;
-- (RLS on petty_cash_entries already exists from 00064 and covers the new column.)

ALTER TABLE petty_cash_entries
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);

CREATE INDEX IF NOT EXISTS idx_pc_entries_location ON petty_cash_entries(location_id);

UPDATE petty_cash_entries e
SET location_id = ul.location_id
FROM (
  SELECT user_id, (array_agg(location_id))[1] AS location_id
  FROM user_locations
  WHERE responsibility = 'primary'
  GROUP BY user_id
  HAVING COUNT(*) = 1
) ul
WHERE e.location_id IS NULL
  AND e.submitted_by = ul.user_id;
