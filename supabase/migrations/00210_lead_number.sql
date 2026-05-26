-- Add a human-readable sequential lead number.
-- Uses a dedicated sequence so the number is never reused even if a lead is deleted.

CREATE SEQUENCE IF NOT EXISTS leads_number_seq START 1001;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS lead_number INTEGER;

-- Backfill existing leads in creation order
UPDATE leads
SET lead_number = sub.new_num
FROM (
  SELECT id, nextval('leads_number_seq') AS new_num
  FROM leads
  ORDER BY created_at ASC
) sub
WHERE leads.id = sub.id;

-- Make it non-nullable with a sequence default going forward
ALTER TABLE leads
  ALTER COLUMN lead_number SET NOT NULL,
  ALTER COLUMN lead_number SET DEFAULT nextval('leads_number_seq');

-- Unique constraint so it can be used as a search key
ALTER TABLE leads
  ADD CONSTRAINT leads_lead_number_unique UNIQUE (lead_number);
