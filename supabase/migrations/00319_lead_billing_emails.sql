-- Add billing_emails array to leads for multi-recipient invoice distribution.
-- Backfills existing secondary_email values into the new array.
-- secondary_email column is kept (not dropped) for historical data compatibility.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS billing_emails text[] NOT NULL DEFAULT '{}';

-- Backfill: any lead with a secondary_email gets it as the first billing email
UPDATE leads
SET billing_emails = ARRAY[secondary_email]
WHERE secondary_email IS NOT NULL AND secondary_email <> '';
