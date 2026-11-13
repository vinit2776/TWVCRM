-- The day the service visit actually happened. period_from / period_to stay as the billing cycle the
-- report belongs to (now filled in from the cycle number rather than typed), so existing screens keep working.
ALTER TABLE po_service_reports ADD COLUMN IF NOT EXISTS service_date DATE;
