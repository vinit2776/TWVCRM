-- Blanket approval sub-options on property_leases
-- blanket_expires_on: null = auto-approve for full lease tenure, date = auto-approve until that date
-- blanket_on_hold:    true = blanket approval paused (cron generates as pending)
-- blanket_hold_until: null = hold indefinitely (admin must lift), date = hold expires on that date (cron auto-lifts)

ALTER TABLE property_leases
  ADD COLUMN IF NOT EXISTS blanket_expires_on   DATE,
  ADD COLUMN IF NOT EXISTS blanket_on_hold       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS blanket_hold_until    DATE;
