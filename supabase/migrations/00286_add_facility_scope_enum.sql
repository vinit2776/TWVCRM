-- Add 'facility' scope to the facility_scope enum.
-- Must run in its own transaction (committed before any INSERT uses the new value).
ALTER TYPE facility_scope ADD VALUE IF NOT EXISTS 'facility';
