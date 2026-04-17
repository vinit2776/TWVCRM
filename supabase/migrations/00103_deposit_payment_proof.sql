-- Add screenshot/proof URL for manually-recorded deposit payments
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_payment_screenshot_url TEXT;
