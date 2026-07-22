-- Optional day-precise end date for a rate phase, overriding the default
-- calendar-month-bucket boundary derived from duration_months. Nullable —
-- existing phases (and new ones left un-customised) keep working exactly as
-- before; only phases with an explicit end_date get day-precise proration.
ALTER TABLE contract_rate_phases
  ADD COLUMN IF NOT EXISTS end_date DATE;
