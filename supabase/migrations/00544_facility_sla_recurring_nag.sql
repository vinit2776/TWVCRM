-- Tracks the last time a still-open, SLA-breached facility issue was
-- included in an SLA-breach alert email, so facility-sla-check can re-fire
-- a daily nag on old breaches instead of alerting only once at breach time.
ALTER TABLE facility_issues
  ADD COLUMN IF NOT EXISTS sla_breach_last_notified_at TIMESTAMPTZ;
