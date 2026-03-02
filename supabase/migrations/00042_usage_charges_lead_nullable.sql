-- Make usage_charges.lead_id nullable.
-- Walk-in bookings without an associated lead were causing constraint
-- violations when a usage charge was logged against them.

ALTER TABLE usage_charges
  ALTER COLUMN lead_id DROP NOT NULL;
