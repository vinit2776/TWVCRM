-- Occupation start date for prorated first month GST invoice
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS occupation_start_date DATE;
